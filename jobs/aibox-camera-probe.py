#!/usr/bin/env python3
"""Camera RTSP helper: burst health probe and 1-minute evidence capture.

Modes:
  inventory <ip?>         list locally configured camera slots (no credentials)
  probe <ip>              10 frames, one every 6 seconds, from the substream;
                          prints {"method":"image","frames":N,"valid_frames":M}
  capture                 one sub frame (archive, keep 100) + one main frame
                          (staging, keep 2) per camera; used by the 60s daemon

Credentials never leave this box; images are only written under CAPTURE_ROOT.
"""
import argparse
import glob
import io
import json
import math
import os
import subprocess
import sys
import time
from urllib.parse import urlsplit, urlunsplit

from PIL import Image, ImageStat

CONFIG_GLOB = os.path.expanduser("~/apps/agent/machinery/agent*/data/config/config.json")
RESOLVER_PATH = os.path.expanduser("~/.aibox-camera-probe.json")
CAPTURE_ROOT = os.path.expanduser("~/aibox-camera-capture")
ARCHIVE_KEEP = 100
LATEST_KEEP = 2
# Keep mainstream stills under the hub download budget.
SNAPSHOT_TARGET_BYTES = 150 * 1024
WIDTH, HEIGHT = 160, 120
FRAME_BYTES = WIDTH * HEIGHT
BURST_COUNT = 10
BURST_INTERVAL_SECONDS = 6
BURST_TOTAL_SECONDS = BURST_COUNT * BURST_INTERVAL_SECONDS + 10
SHOT_TIMEOUT_SECONDS = 10
PASSWORDS = ["123456", "Halong6886"]

SUBSTREAM_RULES = (
    ("/mpeg4", "/mpeg4cif"),
    ("/Streaming/Channels/101", "/Streaming/Channels/102"),
    ("/cam/realmonitor?channel=1&subtype=0", "/cam/realmonitor?channel=1&subtype=1"),
    ("/ch01/0", "/ch01/1"),
    ("/live/0/MAIN", "/live/0/SUB"),
    ("/stream1", "/stream2"),
)


def _slot_name(path):
    return os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(path))))


def _load_json(path):
    try:
        with open(path, encoding="utf-8") as file:
            return json.load(file)
    except (OSError, ValueError, TypeError):
        return None


def machinery_cameras():
    """camera_ip -> {"main": uri} from machinery slot configs (both schemas)."""
    found = {}
    for path in sorted(glob.glob(CONFIG_GLOB)):
        item = _load_json(path)
        if not isinstance(item, dict):
            continue
        uri = None
        camera = item.get("camera")
        if isinstance(camera, dict):
            main = camera.get("mainStream")
            if isinstance(main, dict) and isinstance(main.get("uri"), str):
                uri = main["uri"]
        if not uri:
            legacy = item.get("capture", {}).get("ipcamera", {}) if isinstance(item.get("capture"), dict) else {}
            if isinstance(legacy.get("rtsp"), str):
                uri = legacy["rtsp"]
        if uri:
            camera_ip = urlsplit(uri).hostname
            if camera_ip:
                found.setdefault(camera_ip, {"main": uri})
    return found


def resolver_cameras():
    """camera_ip -> templates from the fallback resolver file (mxa2-style boxes)."""
    item = _load_json(RESOLVER_PATH)
    if not isinstance(item, dict):
        return {}
    sub = item.get("sub_template")
    main = item.get("main_template")
    if not isinstance(sub, str) or not isinstance(main, str):
        return {}
    passwords = item.get("passwords") if isinstance(item.get("passwords"), list) else PASSWORDS
    cameras = {}
    for camera_ip in item.get("cameras", []):
        if isinstance(camera_ip, str):
            cameras[camera_ip] = {"sub_template": sub, "main_template": main, "passwords": passwords}
    return cameras


def cameras():
    found = machinery_cameras()
    for camera_ip, entry in resolver_cameras().items():
        found.setdefault(camera_ip, entry)
    return found


def inventory():
    return {ip: _slot_name(path) for path in sorted(glob.glob(CONFIG_GLOB))
            for uri in [(_load_json(path) or {}).get("camera", {}).get("mainStream", {}).get("uri")]
            if isinstance(uri, str) and urlsplit(uri).hostname
            for ip in [urlsplit(uri).hostname]}


def substream_uri(main_uri):
    split = urlsplit(main_uri)
    path_query = split.path + ("?" + split.query if split.query else "")
    for main_marker, sub_marker in SUBSTREAM_RULES:
        if path_query == main_marker or path_query.startswith(main_marker + "?"):
            return urlunsplit((split.scheme, split.netloc, split.path,
                               split.query, split.fragment)).replace(main_marker, sub_marker, 1)
    return main_uri


def _with_password(uri, password):
    split = urlsplit(uri)
    host = split.hostname or ""
    port = f":{split.port}" if split.port else ""
    netloc = f"admin:{password}@{host}{port}"
    return urlunsplit((split.scheme, netloc, split.path, split.query, split.fragment))


def _render(template, values):
    out = template
    for key, value in values.items():
        out = out.replace("{" + key + "}", value)
    return out


def grab_gray(uri, count, interval_seconds):
    """Sample `count` grayscale frames, one every `interval_seconds`; returns bytes blob."""
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "quiet",
        "-rtsp_transport", "tcp", "-i", uri,
        "-vf", f"fps=1/{interval_seconds},scale={WIDTH}:{HEIGHT},format=gray",
        "-frames:v", str(count), "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
    ]
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=BURST_TOTAL_SECONDS, check=False)
    except FileNotFoundError:
        return None
    except subprocess.TimeoutExpired as error:
        return error.stdout or b""
    except OSError:
        return None
    return result.stdout


def grab_jpeg(uri, timeout=SHOT_TIMEOUT_SECONDS):
    """One full-resolution JPEG frame; returns bytes or None."""
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "quiet",
        "-rtsp_transport", "tcp", "-i", uri,
        "-frames:v", "1", "-q:v", "4", "-f", "image2", "-vcodec", "mjpeg", "pipe:1",
    ]
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=timeout, check=False)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    return result.stdout if result.stdout.startswith(b"\xff\xd8") else None


def frame_is_valid(frame):
    image = Image.frombytes("L", (WIDTH, HEIGHT), frame)
    pixels = image.tobytes()
    stats = ImageStat.Stat(image)
    mean = stats.mean[0]
    stddev = stats.stddev[0]
    if mean <= 8 and stddev <= 5:
        return False
    if stddev < 2.5:
        return False
    horizontal = sum(abs(pixels[i] - pixels[i - 1]) for i in range(1, len(pixels)) if i % WIDTH)
    vertical = sum(abs(pixels[i] - pixels[i - WIDTH]) for i in range(WIDTH, len(pixels)))
    pair_count = (HEIGHT * (WIDTH - 1)) + ((HEIGHT - 1) * WIDTH)
    roughness = (horizontal + vertical) / pair_count
    if stddev >= 30 and roughness / stddev > 1.05:
        histogram = image.histogram()
        entropy = -sum((n / len(pixels)) * math.log2(n / len(pixels)) for n in histogram if n)
        if entropy > 7.0:
            return False
    return True


def jpeg_is_valid(blob):
    try:
        image = Image.open(__import__("io").BytesIO(blob)).convert("L")
        image = image.resize((WIDTH, HEIGHT))
    except Exception:
        return False
    return frame_is_valid(image.tobytes())


def first_media_uri(candidates, timeout=SHOT_TIMEOUT_SECONDS):
    for uri in candidates:
        blob = grab_jpeg(uri, timeout)
        if blob is not None:
            return uri
    return None


def probe(camera_ip):
    entry = cameras().get(camera_ip)
    if not entry:
        return {"method": "unsupported", "status": "fallback"}
    if "sub_template" in entry:
        candidates = [_render(entry["sub_template"], {"ip": camera_ip, "password": pw})
                      for pw in entry.get("passwords", PASSWORDS)]
        uri = first_media_uri(candidates)
        if not uri:
            return {"method": "image", "status": "offline", "frames": 0, "valid_frames": 0}
    else:
        uri = substream_uri(entry["main"])
    blob = grab_gray(uri, BURST_COUNT, BURST_INTERVAL_SECONDS)
    if blob is None:
        return {"method": "unsupported", "status": "fallback"}
    frames = [blob[i:i + FRAME_BYTES] for i in range(0, len(blob), FRAME_BYTES)]
    frames = [frame for frame in frames if len(frame) == FRAME_BYTES][:BURST_COUNT]
    valid = sum(frame_is_valid(frame) for frame in frames)
    status = "online" if valid else "offline"
    return {"method": "image", "status": status, "frames": len(frames), "valid_frames": valid}


def prune_dir(directory, keep, prefix):
    try:
        entries = sorted(name for name in os.listdir(directory) if name.startswith(prefix))
    except OSError:
        return
    for name in entries[:-keep] if len(entries) > keep else []:
        try:
            os.unlink(os.path.join(directory, name))
        except OSError:
            pass


def store_jpeg(directory, filename, blob, valid=None):
    os.makedirs(directory, exist_ok=True)
    suffix = ""
    if valid is not None:
        suffix = "-ok" if valid else "-bad"
    stem, ext = os.path.splitext(filename)
    tmp = os.path.join(directory, f".{stem}{suffix}.tmp")
    with open(tmp, "wb") as file:
        file.write(blob)
    final = os.path.join(directory, f"{stem}-{time.time_ns()}{suffix}{ext}")
    os.replace(tmp, final)
    return final


def shrink_jpeg(blob, target=SNAPSHOT_TARGET_BYTES):
    """Re-encode an oversized mainstream still so it stays transferable."""
    if len(blob) <= target:
        return blob
    try:
        image = Image.open(io.BytesIO(blob)).convert("RGB")
    except Exception:
        return blob
    candidate_blob = blob
    for scale, quality in ((1.0, 85), (0.85, 80), (0.72, 75),
                           (0.6, 70), (0.5, 65), (0.4, 60)):
        if scale == 1.0:
            candidate = image
        else:
            size = (max(320, int(image.width * scale)),
                    max(240, int(image.height * scale)))
            candidate = image.resize(size, Image.LANCZOS)
        buffer = io.BytesIO()
        candidate.save(buffer, format="JPEG", quality=quality, optimize=True)
        candidate_blob = buffer.getvalue()
        if len(candidate_blob) <= target:
            return candidate_blob
    return candidate_blob


def log(message):
    """One structured stderr line; never logs URIs (they may embed credentials)."""
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    print(f"{stamp} aibox-camera-probe: {message}", file=sys.stderr)


def capture_camera(camera_ip, entry):
    wrote = False
    if "sub_template" in entry:
        sub_candidates = [_render(entry["sub_template"], {"ip": camera_ip, "password": pw})
                          for pw in entry.get("passwords", PASSWORDS)]
        main_candidates = [_render(entry["main_template"], {"ip": camera_ip, "password": pw})
                           for pw in entry.get("passwords", PASSWORDS)]
        sub_uri = first_media_uri(sub_candidates)
        main_uri = first_media_uri(main_candidates) if sub_uri else None
    else:
        sub_uri = substream_uri(entry["main"])
        main_uri = entry["main"]
    if sub_uri:
        blob = grab_jpeg(sub_uri)
        if blob is not None:
            store_jpeg(os.path.join(CAPTURE_ROOT, "archive", camera_ip), "sub.jpg", blob,
                       valid=jpeg_is_valid(blob))
            prune_dir(os.path.join(CAPTURE_ROOT, "archive", camera_ip), ARCHIVE_KEEP, "sub-")
            wrote = True
    if main_uri:
        blob = grab_jpeg(main_uri)
        if blob is not None:
            store_jpeg(os.path.join(CAPTURE_ROOT, "latest", camera_ip), "main.jpg",
                       shrink_jpeg(blob))
            prune_dir(os.path.join(CAPTURE_ROOT, "latest", camera_ip), LATEST_KEEP, "main-")
            wrote = True
    if not wrote:
        log(f"no frame for {camera_ip}: upstream feed returned nothing")
    return wrote


def capture():
    known = cameras()
    failures = 0
    noframes = 0
    for camera_ip, entry in sorted(known.items()):
        try:
            if capture_camera(camera_ip, entry):
                continue
            noframes += 1
        except Exception as error:
            failures += 1
            log(f"capture failed for {camera_ip}: {error}")
    if noframes:
        log(f"capture finished with {noframes} no-frame cameras")
    if failures:
        log(f"capture finished with {failures} failures")
    if known and noframes + failures >= len(known):
        log(f"capture wrote nothing: all {len(known)} cameras failed")
        return 1
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("inventory", "probe", "capture"))
    parser.add_argument("camera_ip", nargs="?")
    args = parser.parse_args()
    if args.mode == "inventory":
        print(json.dumps(inventory()))
        return 0
    if args.mode == "capture":
        return capture()
    if not args.camera_ip:
        return 2
    print(json.dumps(probe(args.camera_ip)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
