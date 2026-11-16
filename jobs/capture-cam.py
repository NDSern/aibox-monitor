#!/usr/bin/env python3
"""capture-cam: polished per-box camera evidence capture.

Replaces aibox-camera-capture with the same on-disk layout, so the
downstream snapshot puller keeps working unchanged:

  ~/aibox-camera-capture/latest/<camera>/main-<ns>.jpg   (keep 2, for boxtest2 pulls)
  ~/aibox-camera-capture/archive/<camera>/sub-<ns>-ok|bad.jpg (keep 100)
  ~/aibox-camera-capture/latest/<camera>/main-<ns>.jpg (keep 2)

Modes:
  inventory              list locally configured camera slots (no credentials)
  probe <ip>             10-frame burst health probe (same JSON as before)
  capture                one sub frame (archive) + one main frame (latest)
  status                 JSON health summary of the capture tree
  selftest               environment + source check (ffmpeg, PIL, config)

Refinements over aibox-camera-probe:
  - working-password cache for resolver-style boxes (never stores secrets;
    only the index into the password list, re-verified every 6 hours)
  - structured stderr logging for journal collection
  - `status` and `selftest` for health monitoring
  - atomic cache writes, safer pruning, per-camera error isolation

Credentials never leave this box; images are only written under CAPTURE_ROOT.
"""
import argparse
import glob
import io
import json
import math
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit, urlunsplit

from PIL import Image, ImageStat

CONFIG_GLOB = os.path.expanduser("~/apps/agent/machinery/agent*/data/config/config.json")
RESOLVER_PATH = os.path.expanduser("~/.aibox-camera-probe.json")
CAPTURE_ROOT = os.path.expanduser("~/aibox-camera-capture")
CACHE_PATH = os.path.join(CAPTURE_ROOT, ".capture-cam-cache.json")
CACHE_TTL_SECONDS = 6 * 3600
ARCHIVE_KEEP = 100
LATEST_KEEP = 2
# Mainstream stills are evidence, but they must stay under the hub download
# budget; anything bigger is downscaled on the box before it is stored.
SNAPSHOT_TARGET_BYTES = 150 * 1024
# Archive substream frames share the same hub download cap as stills; keep
# both under it so the Shell Fleet path transfers them in one chunk.
ARCHIVE_TARGET_BYTES = 150 * 1024
WIDTH, HEIGHT = 160, 120
FRAME_BYTES = WIDTH * HEIGHT
BURST_COUNT = 10
BURST_INTERVAL_SECONDS = 6
BURST_TOTAL_SECONDS = BURST_COUNT * BURST_INTERVAL_SECONDS + 10
SHOT_TIMEOUT_SECONDS = 25
CAPTURE_WORKERS = 4
DEFAULT_PASSWORDS = ["123456", "Halong6886"]

SUBSTREAM_RULES = (
    ("/mpeg4", "/mpeg4cif"),
    ("/Streaming/Channels/101", "/Streaming/Channels/102"),
    ("/cam/realmonitor?channel=1&subtype=0", "/cam/realmonitor?channel=1&subtype=1"),
    ("/ch01/0", "/ch01/1"),
    ("/live/0/MAIN", "/live/0/SUB"),
    ("/stream1", "/stream2"),
)


def log(message):
    """One structured stderr line; never logs URIs (they may embed credentials)."""
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    print(f"{stamp} capture-cam: {message}", file=sys.stderr)


# ---- config sources -------------------------------------------------------

def _load_json(path):
    try:
        with open(path, encoding="utf-8") as file:
            return json.load(file)
    except (OSError, ValueError, TypeError):
        return None


def _slot_name(path):
    return os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(path))))


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
                found.setdefault(camera_ip, {"main": uri, "slot": _slot_name(path)})
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
    passwords = item.get("passwords") if isinstance(item.get("passwords"), list) else DEFAULT_PASSWORDS
    cameras = {}
    for camera_ip in item.get("cameras", []):
        if isinstance(camera_ip, str):
            cameras[camera_ip] = {"sub_template": sub, "main_template": main,
                                  "passwords": passwords, "slot": "resolver"}
    return cameras


def cameras():
    found = machinery_cameras()
    for camera_ip, entry in resolver_cameras().items():
        found.setdefault(camera_ip, entry)
    return found


def inventory():
    return {ip: entry.get("slot", "") for ip, entry in sorted(cameras().items())}


# ---- uri helpers ----------------------------------------------------------

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


# ---- password cache (index only, never secrets) ---------------------------

def _load_cache():
    item = _load_json(CACHE_PATH)
    return item if isinstance(item, dict) else {}


def _store_cache(cache):
    try:
        os.makedirs(CAPTURE_ROOT, exist_ok=True)
        temp = CACHE_PATH + f".tmp-{os.getpid()}"
        with open(temp, "w", encoding="utf-8") as file:
            json.dump(cache, file)
        os.replace(temp, CACHE_PATH)
        os.chmod(CACHE_PATH, 0o600)
    except OSError as error:
        log(f"cache write failed: {error}")


def _cache_candidates(entry, kind, camera_ip, cache):
    """Rendered candidate URIs for kind ("sub"|"main"), cached index first."""
    template_key = f"{kind}_template"
    template = entry.get(template_key)
    if not template:
        return []
    passwords = entry.get("passwords", DEFAULT_PASSWORDS)
    order = list(range(len(passwords)))
    hit = cache.get(camera_ip, {}).get(kind)
    now = time.time()
    fresh = hit and isinstance(hit.get("index"), int) and 0 <= hit["index"] < len(passwords) \
        and now - hit.get("ts", 0) < CACHE_TTL_SECONDS
    if fresh and hit["index"] != 0:
        order.remove(hit["index"])
        order.insert(0, hit["index"])
    return [(_render(template, {"ip": camera_ip, "password": passwords[index]}), index)
            for index in order]


def _remember(cache, camera_ip, kind, index):
    entry = cache.setdefault(camera_ip, {})
    entry[kind] = {"index": index, "ts": time.time()}


# ---- media ----------------------------------------------------------------

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
        image = Image.open(io.BytesIO(blob)).convert("L")
        image = image.resize((WIDTH, HEIGHT))
    except Exception:
        return False
    return frame_is_valid(image.tobytes())


def shrink_jpeg(blob, target=SNAPSHOT_TARGET_BYTES):
    """Re-encode a mainstream still until it fits the transfer budget.

    The hub download path caps a single transfer well below a 1080p camera
    still (~400 KiB to 1.5 MiB), so oversized frames can never be pulled.
    Downscaling on the box keeps every still deliverable without changing the
    on-disk layout the puller expects.
    """
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


def first_media_uri(candidates, timeout=SHOT_TIMEOUT_SECONDS):
    """candidates: [(uri, tag)]; returns (uri, tag) or (None, None)."""
    for uri, tag in candidates:
        blob = grab_jpeg(uri, timeout)
        if blob is not None:
            return uri, tag
    return None, None


# ---- probe ----------------------------------------------------------------

def probe(camera_ip, cache=None):
    cache = _load_cache() if cache is None else cache
    entry = cameras().get(camera_ip)
    if not entry:
        return {"method": "unsupported", "status": "fallback"}
    if "sub_template" in entry:
        uri, index = first_media_uri(_cache_candidates(entry, "sub", camera_ip, cache))
        if not uri:
            return {"method": "image", "status": "offline", "frames": 0, "valid_frames": 0}
        _remember(cache, camera_ip, "sub", index)
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


# ---- capture --------------------------------------------------------------



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


def capture_camera(camera_ip, entry, cache):
    """Capture one substream frame into the archive and one mainstream into latest.

    Returns True when at least one frame was written, False when the upstream
    feed produced nothing (so the caller can report it).
    """
    wrote = False
    if "sub_template" in entry:
        sub_uri, index = first_media_uri(_cache_candidates(entry, "sub", camera_ip, cache))
        if sub_uri:
            _remember(cache, camera_ip, "sub", index)
            main_uri, main_index = first_media_uri(
                _cache_candidates(entry, "main", camera_ip, cache))
            if main_uri:
                _remember(cache, camera_ip, "main", main_index)
        else:
            main_uri = None
    else:
        sub_uri = substream_uri(entry["main"])
        main_uri = entry["main"]
    if sub_uri:
        blob = grab_jpeg(sub_uri)
        if blob is not None:
            shot = shrink_jpeg(blob, ARCHIVE_TARGET_BYTES)
            store_jpeg(os.path.join(CAPTURE_ROOT, "archive", camera_ip), "sub.jpg", shot,
                       valid=jpeg_is_valid(shot))
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
    cache = _load_cache()
    failures = 0
    noframes = 0

    def run(item):
        camera_ip, entry = item
        try:
            return camera_ip, capture_camera(camera_ip, entry, cache)
        except Exception as error:
            return camera_ip, error

    workers = min(CAPTURE_WORKERS, max(1, len(known)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for camera_ip, status in pool.map(run, sorted(known.items())):
            if isinstance(status, BaseException):
                failures += 1
                log(f"capture failed for {camera_ip}: {status}")
            elif status is False:
                noframes += 1
    for stale_ip in [ip for ip in _load_cache() if ip not in known]:
        cache.pop(stale_ip, None)
    _store_cache(cache)
    if noframes:
        log(f"capture finished with {noframes} no-frame cameras")
    if failures:
        log(f"capture finished with {failures} failures")
    if known and noframes + failures >= len(known):
        log(f"capture wrote nothing: all {len(known)} cameras failed")
        return 1
    return 0


# ---- status / selftest ----------------------------------------------------

def status():
    latest_root = os.path.join(CAPTURE_ROOT, "latest")
    cameras_found = 0
    freshest = oldest = 0
    files = 0
    if os.path.isdir(latest_root):
        for camera_ip in os.listdir(latest_root):
            directory = os.path.join(latest_root, camera_ip)
            if not os.path.isdir(directory):
                continue
            shots = [entry for entry in os.listdir(directory) if entry.startswith("main-")]
            if not shots:
                continue
            cameras_found += 1
            for name in shots:
                mtime = os.path.getmtime(os.path.join(directory, name))
                files += 1
                freshest = max(freshest, mtime)
                oldest = min(oldest, mtime) if oldest else mtime
    return {
        "cameras_with_latest": cameras_found,
        "files": files,
        "freshest_age_seconds": round(time.time() - freshest) if freshest else None,
        "oldest_age_seconds": round(time.time() - oldest) if oldest else None,
    }


def selftest():
    report = {"ffmpeg": bool(shutil.which("ffmpeg")), "pillow": True,
              "machinery_configs": len(glob.glob(CONFIG_GLOB)),
              "resolver_file": os.path.isfile(RESOLVER_PATH),
              "cameras": len(cameras()),
              "capture_root_writable": os.access(CAPTURE_ROOT, os.W_OK)}
    try:
        import PIL  # noqa: F401
    except ImportError:
        report["pillow"] = False
    ok = report["ffmpeg"] and report["pillow"] and report["cameras"] > 0
    report["ok"] = ok
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("mode", choices=("inventory", "probe", "capture", "status", "selftest"))
    parser.add_argument("camera_ip", nargs="?")
    args = parser.parse_args()
    if args.mode == "inventory":
        print(json.dumps(inventory()))
        return 0
    if args.mode == "capture":
        return capture()
    if args.mode == "status":
        print(json.dumps(status()))
        return 0
    if args.mode == "selftest":
        print(json.dumps(selftest()))
        return 0 if selftest()["ok"] else 1
    if not args.camera_ip:
        return 2
    cache = _load_cache()
    result = probe(args.camera_ip, cache)
    _store_cache(cache)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
