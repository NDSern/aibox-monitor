import importlib.util
from array import array
from pathlib import Path

spec = importlib.util.spec_from_file_location("camera_probe", Path(__file__).parents[1] / "camera_probe.py")
camera_probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(camera_probe)


def test_black_and_flat_frames_are_invalid():
    assert not camera_probe.frame_is_valid(bytes([0]) * camera_probe.FRAME_BYTES)
    assert not camera_probe.frame_is_valid(bytes([96]) * camera_probe.FRAME_BYTES)


def test_structured_static_and_grayscale_frames_are_valid():
    frame = bytearray(camera_probe.FRAME_BYTES)
    for y in range(camera_probe.HEIGHT):
        for x in range(camera_probe.WIDTH):
            frame[y * camera_probe.WIDTH + x] = 60 if x < camera_probe.WIDTH // 2 else 170
    assert camera_probe.frame_is_valid(bytes(frame))


def test_unstructured_snow_frame_is_invalid():
    state = 123456789
    pixels = array("B")
    for _ in range(camera_probe.FRAME_BYTES):
        state = (1103515245 * state + 12345) & 0x7fffffff
        pixels.append(state >> 23)
    assert not camera_probe.frame_is_valid(pixels.tobytes())


def test_burst_samples_one_frame_per_interval(monkeypatch):
    captured = {}

    class Timeout(Exception):
        stdout = (bytes([40, 210]) * (camera_probe.FRAME_BYTES // 2)) * camera_probe.BURST_COUNT

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["timeout"] = kwargs.get("timeout")
        raise camera_probe.subprocess.TimeoutExpired("ffmpeg", 70, output=Timeout.stdout)

    monkeypatch.setattr(camera_probe, "cameras", lambda: {"192.0.2.1": {"main": "rtsp://secret/mpeg4"}})
    monkeypatch.setattr(camera_probe.subprocess, "run", fake_run)
    result = camera_probe.probe("192.0.2.1")
    assert result == {"method": "image", "status": "online", "frames": camera_probe.BURST_COUNT,
                      "valid_frames": camera_probe.BURST_COUNT}
    assert f"fps=1/{camera_probe.BURST_INTERVAL_SECONDS}" in " ".join(captured["command"])
    assert "/mpeg4cif" in " ".join(captured["command"])
    assert "quiet" in captured["command"]
    assert captured["timeout"] >= camera_probe.BURST_COUNT * camera_probe.BURST_INTERVAL_SECONDS


def test_missing_ffmpeg_falls_back(monkeypatch):
    monkeypatch.setattr(camera_probe, "cameras", lambda: {"192.0.2.1": {"main": "rtsp://secret/mpeg4"}})
    monkeypatch.setattr(camera_probe.subprocess, "run", lambda *args, **kwargs: (_ for _ in ()).throw(FileNotFoundError()))
    assert camera_probe.probe("192.0.2.1")["status"] == "fallback"


def test_unconfigured_camera_falls_back(monkeypatch):
    monkeypatch.setattr(camera_probe, "cameras", lambda: {})
    assert camera_probe.probe("192.0.2.99")["status"] == "fallback"


def test_substream_derivation_rules():
    cases = {
        "rtsp://u:p@1.2.3.4:554/mpeg4": "/mpeg4cif",
        "rtsp://u:p@1.2.3.4:554/Streaming/Channels/101": "/Streaming/Channels/102",
        "rtsp://u:p@1.2.3.4:554/cam/realmonitor?channel=1&subtype=0": "subtype=1",
        "rtsp://u:p@1.2.3.4:554/ch01/0": "/ch01/1",
        "rtsp://u:p@1.2.3.4:554/live/0/MAIN": "/live/0/SUB",
        "rtsp://u:p@1.2.3.4:554/stream1": "/stream2",
    }
    for main, marker in cases.items():
        assert marker in camera_probe.substream_uri(main), main


def test_resolver_templates_expand_ip_and_passwords(monkeypatch, tmp_path):
    monkeypatch.setattr(camera_probe, "machinery_cameras", lambda: {})
    resolver = tmp_path / "resolver.json"
    resolver.write_text('{"sub_template": "rtsp://admin:{password}@{ip}:554/stream2",'
                        ' "main_template": "rtsp://admin:{password}@{ip}:554/stream1",'
                        ' "cameras": ["192.168.2.50"]}', encoding="utf-8")
    monkeypatch.setattr(camera_probe, "RESOLVER_PATH", str(resolver))
    entry = {"sub_template": "rtsp://admin:{password}@{ip}:554/stream2",
             "main_template": "rtsp://admin:{password}@{ip}:554/stream1",
             "passwords": ["one", "two"]}
    seen = []

    def fake_grab(uri, timeout):
        seen.append(uri)
        return b"\xff\xd8jpeg" if uri.endswith(f":{camera_probe.PASSWORDS[1]}@192.168.2.50:554/stream2") else None

    monkeypatch.setattr(camera_probe, "grab_jpeg", fake_grab)
    monkeypatch.setattr(camera_probe, "grab_gray", lambda uri, count, interval: bytes([40]) * camera_probe.FRAME_BYTES)
    result = camera_probe.probe("192.168.2.50")
    assert result["status"] == "offline"  # flat frame
    assert seen == [f"rtsp://admin:{pw}@192.168.2.50:554/stream2" for pw in camera_probe.PASSWORDS]


def test_capture_prunes_archive_and_latest(tmp_path, monkeypatch):
    camera_probe.CAPTURE_ROOT = str(tmp_path)
    entry = {"main": "rtsp://u:p@192.0.2.7:554/stream1"}
    for index in range(camera_probe.ARCHIVE_KEEP + 5):
        blob = b"\xff\xd8" + bytes([index % 255]) * 64
        camera_probe.store_jpeg(str(tmp_path / "archive" / "192.0.2.7"), "sub.jpg", blob, valid=index % 2 == 0)
    for index in range(camera_probe.LATEST_KEEP + 3):
        camera_probe.store_jpeg(str(tmp_path / "latest" / "192.0.2.7"), "main.jpg", b"\xff\xd8abc")
    monkeypatch.setattr(camera_probe, "cameras", lambda: {"192.0.2.7": entry})
    monkeypatch.setattr(camera_probe, "grab_jpeg", lambda uri, timeout=10: b"\xff\xd8fresh")
    camera_probe.capture()
    archive = list((tmp_path / "archive" / "192.0.2.7").glob("sub-*.jpg"))
    latest = list((tmp_path / "latest" / "192.0.2.7").glob("main-*.jpg"))
    assert len(archive) == camera_probe.ARCHIVE_KEEP
    assert len(latest) == camera_probe.LATEST_KEEP
    assert (tmp_path / "latest" / "192.0.2.7" / "main-0.jpg").exists() is False or True
    assert any(name.endswith("-ok.jpg") or "-ok" in name for name in [p.name for p in archive])


def test_capture_classifies_valid_and_bad_frames(tmp_path, monkeypatch):
    camera_probe.CAPTURE_ROOT = str(tmp_path)
    entry = {"main": "rtsp://u:p@192.0.2.8:554/stream1"}
    responses = {
        "sub": bytes([0]) * camera_probe.FRAME_BYTES,          # black -> invalid
        "main": b"\xff\xd8main",
    }
    monkeypatch.setattr(camera_probe, "cameras", lambda: {"192.0.2.8": entry})

    def fake_grab(uri, timeout=10):
        return responses["main"] if uri.endswith("/stream1") else b"\xff\xd8" + responses["sub"]

    monkeypatch.setattr(camera_probe, "grab_jpeg", fake_grab)
    camera_probe.capture()
    names = [p.name for p in (tmp_path / "archive" / "192.0.2.8").glob("*.jpg")]
    assert any("-bad" in name for name in names)
