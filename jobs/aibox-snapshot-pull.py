#!/usr/bin/env python3
"""Pull latest mainstream camera snapshots from AIBOX checkers onto boxtest2.

For each configured (scope, checker) pair, mirrors the retained
~/aibox-camera-capture/latest/<camera>/*.jpg files into the webapp data dir as
data/camera-snapshots/<scope>/<camera>/*.jpg and keeps the newest SNAPSHOT_KEEP
files per camera. Runs every minute via aibox-snapshot-pull.timer.

Transfers are reconciled by filename and size: a snapshot already present
centrally is not downloaded again. This keeps the display fresh without
re-sending the same full-resolution JPEG every minute.

Read-only on the remote side; never transfers RTSP credentials.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, os.environ.get("AIBOX_SHELLFLEET_LIB", "/usr/local/lib/aibox-shellfleet"))
import aibox_shellfleet as sft  # noqa: E402

SNAPSHOT_KEEP = 2
SSH_TIMEOUT = 30
PULL_WORKERS = 6
FILES_PER_BATCH = 100
# One Shell Fleet batch is a single bounded download from the agent sandbox.
# Same 256 KiB hub download cap as the archive path: four snapshots per
# tar stay under it instead of falling back to one request per file.
SHELLFLEET_FILES_PER_BATCH = 4
# One hub download is capped near 256 KiB; keep each batch well under it
# and never waste a tar round trip on a batch that cannot fit.
TRANSFER_BYTES = 200 * 1024
CONNECT_TIMEOUT = 25
REMOTE_DIR = "aibox-camera-capture/latest"
CAMERA_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")
SNAPSHOT_RE = re.compile(r"^main-\d+\.jpg$")
CHECKERS = [
    ("myxuan-lan", "aibox-mxa2@100.64.0.116"),
    ("myxuan-lan", "aibox-mxa3@100.64.0.36"),
    ("giaminh-lan", "aibox-hp1@100.64.0.49"),
    ("td08-lan", "aibox-td08@100.64.0.27"),
    ("td07-lan", "aibox-td07@100.64.0.6"),
    ("td09-lan", "aibox-td09@100.64.0.121"),
    ("th04-lan", "aibox-th04@100.64.0.1"),
    ("th07-lan", "aibox-th07@100.64.0.104"),
    ("starcity-lan", "aibox-starcity@100.64.0.44"),
    ("oceanus-lan", "aibox-oceanus@100.64.0.80"),
    ("neptune-lan", "aibox-neptune@100.64.0.85"),
    ("th05-lan", "aibox-th05@100.64.0.81"),
    ("th09-lan", "aibox-th09@100.64.0.123"),
    ("th06-lan", "aibox-th06@100.64.0.82"),
    ("th08-lan", "aibox-th08@100.64.0.122"),
]


def data_dir():
    return os.environ.get("AIBOX_WEBAPP_DATA_DIR") or os.path.expanduser(
        "~/aibox-monitor/data")


def usage_path():
    return os.path.join(data_dir(), "transfer-usage.jsonl")


def record_usage(job, scope, target, moved, files, seconds, result):
    entry = {
        "at": round(time.time(), 3),
        "job": job,
        "scope": scope,
        "target": target,
        "bytes": int(moved),
        "files": int(files),
        "seconds": round(seconds, 3),
        "result": result,
    }
    try:
        os.makedirs(data_dir(), exist_ok=True)
        fd = os.open(usage_path(), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        try:
            os.write(fd, (json.dumps(entry, separators=(",", ":")) + "\n").encode("utf-8"))
        finally:
            os.close(fd)
    except OSError:
        pass


def ssh(target, remote_command, timeout):
    """Run a remote command through whichever transport owns the device."""
    device = target.rsplit("@", 1)[-1]
    return sft.run(device, remote_command, timeout)


def remote_snapshots(target):
    """Map camera -> {filename: size} using one cheap remote call."""
    listing = ssh(
        target,
        f"cd ~ 2>/dev/null || exit 0; "
        f"find {REMOTE_DIR} -name 'main-*.jpg' -printf '%h %f %s\\n' 2>/dev/null",
        SSH_TIMEOUT,
    )
    if listing.returncode != 0:
        return None, 0
    snapshots = {}
    for line in listing.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split()
        if len(parts) != 3:
            continue
        camera = os.path.basename(parts[0])
        name = parts[1]
        if not CAMERA_RE.match(camera) or not SNAPSHOT_RE.match(name):
            continue
        try:
            size = int(parts[2])
        except ValueError:
            continue
        snapshots.setdefault(camera, {})[name] = size
    return snapshots, len(listing.stdout)


def local_snapshots(scope, camera):
    directory = os.path.join(data_dir(), "camera-snapshots", scope, camera)
    try:
        names = os.listdir(directory)
    except OSError:
        return {}
    found = {}
    for name in names:
        if not SNAPSHOT_RE.match(name):
            continue
        try:
            found[name] = os.path.getsize(os.path.join(directory, name))
        except OSError:
            pass
    return found


def missing_snapshots(scope, remote):
    """Files absent centrally, or present with a different size."""
    pending = []
    for camera, files in remote.items():
        have = local_snapshots(scope, camera)
        for name, size in files.items():
            if have.get(name) == size:
                continue
            pending.append((camera, name, size))
    pending.sort()
    return pending


def fetch_batch(target, scope, entries, staging):
    """Copy one batch of snapshots, falling back to single files.

    Returns (placed_names, fetched_bytes, failed_names) so a short batch is
    reported instead of being silently treated as complete.
    """
    device = target.rsplit("@", 1)[-1]
    projected = sum(size for _camera, _name, size in entries)
    tar_path = os.path.join(staging, "batch.tar")
    names = {(camera, name) for camera, name, _size in entries}
    # SSH streams a whole tar without the hub cap, so only Shell Fleet
    # batches need the byte estimate.
    uncapped = sft.routing(device) != "shellfleet"
    if uncapped or projected <= TRANSFER_BYTES:
        paths = " ".join(
            f"'{REMOTE_DIR}/{camera}/{name}'" for camera, name, _size in entries
        )
        # A file pruned on the ship mid-stream makes tar exit non-zero after it has
        # already streamed the rest; keep whatever arrived and retry only the gaps.
        moved = sft.stream_tar(device, "~", paths, tar_path, SSH_TIMEOUT + 60)
        if moved:
            extract = os.path.join(staging, "files")
            os.makedirs(extract, exist_ok=True)
            placed = set()
            try:
                # tar -xf would honour absolute paths and links sent by a remote host.
                sft.safe_extract(tar_path, extract)
            except Exception:
                placed = set()
            else:
                root = os.path.join(extract, REMOTE_DIR)
                if os.path.isdir(root):
                    for camera in os.listdir(root):
                        if not CAMERA_RE.match(camera):
                            continue
                        source_dir = os.path.join(root, camera)
                        if not os.path.isdir(source_dir):
                            continue
                        destination_dir = os.path.join(data_dir(), "camera-snapshots", scope, camera)
                        os.makedirs(destination_dir, exist_ok=True)
                        for name in os.listdir(source_dir):
                            if not SNAPSHOT_RE.match(name):
                                continue
                            os.replace(os.path.join(source_dir, name),
                                       os.path.join(destination_dir, name))
                            placed.add((camera, name))
            shutil.rmtree(extract, ignore_errors=True)
            if os.path.exists(tar_path):
                os.unlink(tar_path)
            if placed:
                return placed, moved, {entry for entry in names if entry not in placed}

    placed = set()
    failed = set()
    fetched = 0
    for camera, name, size in entries:
        # A still larger than the hub download cap is not a failure: the shim
        # retries transfer_file over SSH, which is uncapped.
        destination_dir = os.path.join(data_dir(), "camera-snapshots", scope, camera)
        os.makedirs(destination_dir, exist_ok=True)
        local = os.path.join(staging, "%s-%s" % (camera, name))
        got = sft.transfer_file(device, f"~/{REMOTE_DIR}/{camera}/{name}", local,
                                SSH_TIMEOUT + 60)
        if not got:
            failed.add((camera, name))
            continue
        os.replace(local, os.path.join(destination_dir, name))
        placed.add((camera, name))
        fetched += got
    return placed, fetched, failed


def take_batch(pending, limit):
    """Pick snapshots for one download under both the count and byte limits."""
    batch = []
    used = 0
    for camera, name, size in pending:
        if len(batch) >= limit:
            break
        if batch and used + size > TRANSFER_BYTES:
            break
        batch.append((camera, name, size))
        used += size
    return batch


def prune(scope, remote):
    """Keep exactly the frames the ship still retains.

    Pruning to "two newest" is not enough: a locally held older frame can
    occupy the second slot while a still-retained remote frame is missing,
    and each run would download that frame only to delete it again.
    """
    for camera, files in remote.items():
        retain = sorted(files)[-SNAPSHOT_KEEP:]
        keep = set(retain)
        destination = os.path.join(data_dir(), "camera-snapshots", scope, camera)
        try:
            names = [name for name in os.listdir(destination) if name.endswith(".jpg")]
        except OSError:
            continue
        for name in names:
            if name in keep:
                continue
            try:
                os.unlink(os.path.join(destination, name))
            except OSError:
                pass


def batch_limit(target, default=FILES_PER_BATCH):
    """Shell Fleet transfers are one bounded download, so keep batches small."""
    device = target.rsplit("@", 1)[-1]
    if sft.routing(device) == "shellfleet":
        return min(default, SHELLFLEET_FILES_PER_BATCH)
    return default


def pull(scope, target, staging_root):
    started = time.time()
    remote, listing_bytes = remote_snapshots(target)
    if remote is None:
        print(f"snapshot pull failed: {scope} {target}", flush=True)
        record_usage("snapshot", scope, target, 0, 0, time.time() - started, "failed")
        return 0, 0, 1
    if not remote:
        record_usage("snapshot", scope, target, 0, 0, time.time() - started, "empty")
        return 0, 0, 0

    pending = missing_snapshots(scope, remote)
    placed = 0
    moved = listing_bytes
    errors = 0
    limit = batch_limit(target)
    while pending:
        batch = take_batch(pending, limit)
        if not batch:
            errors += 1
            break
        with tempfile.TemporaryDirectory(prefix="snapshot-batch-", dir=staging_root) as staging:
            try:
                done, size, failed = fetch_batch(target, scope, batch, staging)
            except subprocess.TimeoutExpired:
                errors += 1
                break
        placed += len(done)
        moved += size
        # Retry only next run: a file that just failed stays local-pending and
        # the run is marked partial, so it cannot masquerade as delivered.
        pending = [entry for entry in pending
                   if (entry[0], entry[1]) not in done]
        if failed:
            errors += 1
            break

    prune(scope, remote)
    result = "ok" if errors == 0 else "partial"
    record_usage("snapshot", scope, target, moved, placed, time.time() - started, result)
    return moved, placed, errors


# --- stale snapshot-pull temp sweep (aibox) ---
def sweep_stale_temps(root="/tmp", max_age_seconds=3600, prefix="snapshot-pull-"):
    """Remove pull temp dirs orphaned by a hard service timeout."""
    removed, freed = 0, 0
    try:
        names = os.listdir(root)
    except OSError:
        return removed, freed
    cutoff = time.time() - max_age_seconds
    for name in names:
        if not name.startswith(prefix):
            continue
        path = os.path.join(root, name)
        try:
            if os.path.getmtime(path) > cutoff:
                continue
            size = 0
            for base, _dirs, files in os.walk(path):
                for filename in files:
                    try:
                        size += os.path.getsize(os.path.join(base, filename))
                    except OSError:
                        pass
            shutil.rmtree(path, ignore_errors=True)
            removed += 1
            freed += size
        except OSError:
            continue
    return removed, freed
# --- end stale snapshot-pull temp sweep ---


def budget_report():
    """Warn when a ship's recorded daily transfer exceeds its budget."""
    limit_mb = os.environ.get("AIBOX_TRANSFER_DAILY_BUDGET_MB")
    try:
        limit = float(limit_mb) if limit_mb else 0
    except ValueError:
        limit = 0
    if limit <= 0:
        return
    today = time.strftime("%Y-%m-%d")
    totals = {}
    try:
        with open(usage_path(), encoding="utf-8") as handle:
            for line in handle:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if time.strftime("%Y-%m-%d", time.localtime(entry.get("at", 0))) != today:
                    continue
                key = (entry.get("target"), entry.get("job"))
                totals[key] = totals.get(key, 0) + int(entry.get("bytes") or 0)
    except OSError:
        return
    for (target, job), moved in sorted(totals.items()):
        if moved > limit * 1e6:
            print(f"transfer budget: {target} {job} {moved / 1e6:.1f} MB today "
                  f"exceeds {limit:.0f} MB", flush=True)


def main():
    removed, freed = sweep_stale_temps()
    if removed:
        print(f"snapshot temp sweep: {removed} dirs, {freed // 1048576} MB", flush=True)
    os.makedirs(data_dir(), exist_ok=True)
    failures = 0
    pulled_bytes = 0
    pulled_files = 0
    with tempfile.TemporaryDirectory(prefix="snapshot-pull-") as tmp_root:
        workers = max(1, min(PULL_WORKERS, len(CHECKERS)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {}
            for scope, target in CHECKERS:
                futures[pool.submit(pull, scope, target, tmp_root)] = (scope, target)
            for future in as_completed(futures):
                scope, target = futures[future]
                try:
                    moved, placed, errors = future.result()
                    pulled_bytes += moved
                    pulled_files += placed
                    if errors:
                        failures += 1
                except (subprocess.TimeoutExpired, OSError) as error:
                    failures += 1
                    print(f"snapshot pull error: {scope} {target}: {type(error).__name__}", flush=True)
    budget_report()
    print(f"snapshot pull: +{pulled_files} files, {pulled_bytes / 1e6:.2f} MB, "
          f"errors {failures}", flush=True)
    return 1 if failures == len(CHECKERS) else 0


if __name__ == "__main__":
    sys.exit(main())