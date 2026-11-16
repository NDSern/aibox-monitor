#!/usr/bin/env python3
"""Pull latest mainstream camera snapshots from AIBOX checkers onto boxtest2.

For each configured (scope, checker) pair, copies ~/aibox-camera-capture/latest/<camera>/*.jpg
into the webapp data dir as data/camera-snapshots/<scope>/<camera>/*.jpg and keeps the
newest SNAPSHOT_KEEP files per camera. Runs every minute via aibox-snapshot-pull.timer.
Read-only on the remote side; never transfers RTSP credentials.
"""
import os
import shutil
import subprocess
import sys
import tempfile

SNAPSHOT_KEEP = 2
SSH_TIMEOUT = 30
CHECKERS = [
    ("kimhoa", "vnpost-kimhoa1@100.64.0.114"),
    ("kimhoa", "vnpost-kimhoa2@100.64.0.115"),
    ("myxuan-lan", "aibox-mxa2@100.64.0.116"),
    ("starcity-lan", "aibox-starcity@100.64.0.44"),
    ("oceanus-lan", "aibox-oceanus@100.64.0.80"),
    ("neptune-lan", "aibox-neptune@100.64.0.85"),
    ("th05-lan", "aibox-th05@100.64.0.81"),
]


def data_dir():
    return os.environ.get("AIBOX_WEBAPP_DATA_DIR") or os.path.expanduser(
        "~/aibox-monitor-webapp/data")


def run(args, timeout):
    return subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          timeout=timeout, check=False)


def pull(scope, target, tmp_root):
    remote_dir = f"aibox-camera-capture/latest"
    result = run(["scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=25",
                  "-o", "StrictHostKeyChecking=accept-new", "-p", "-r",
                  f"{target}:{remote_dir}", str(tmp_root)], timeout=SSH_TIMEOUT + 60)
    if result.returncode != 0:
        print(f"snapshot pull failed: {scope} {target}", flush=True)
        return
    latest_root = os.path.join(tmp_root, "latest")
    if not os.path.isdir(latest_root):
        return
    scope_dir = os.path.join(data_dir(), "camera-snapshots", scope)
    for camera_ip in sorted(os.listdir(latest_root)):
        source = os.path.join(latest_root, camera_ip)
        if not os.path.isdir(source):
            continue
        destination = os.path.join(scope_dir, camera_ip)
        os.makedirs(destination, exist_ok=True)
        for name in os.listdir(source):
            shutil.copy2(os.path.join(source, name), os.path.join(destination, name))
        snapshots = sorted((name for name in os.listdir(destination) if name.endswith(".jpg")),
                           key=lambda name: os.path.getmtime(os.path.join(destination, name)))
        for name in snapshots[:-SNAPSHOT_KEEP] if len(snapshots) > SNAPSHOT_KEEP else []:
            try:
                os.unlink(os.path.join(destination, name))
            except OSError:
                pass


def main():
    os.makedirs(data_dir(), exist_ok=True)
    failures = 0
    with tempfile.TemporaryDirectory(prefix="snapshot-pull-") as tmp_root:
        for scope, target in CHECKERS:
            try:
                pull(scope, target, tempfile.mkdtemp(dir=tmp_root))
            except (subprocess.TimeoutExpired, OSError) as error:
                failures += 1
                print(f"snapshot pull error: {scope} {target}: {type(error).__name__}", flush=True)
    return 1 if failures == len(CHECKERS) else 0


if __name__ == "__main__":
    sys.exit(main())
