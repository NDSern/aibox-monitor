#!/usr/bin/env python3
"""Mirror substream history from AIBOX checkers into the webapp archive.

The archive is reconciled by filename, not by time: every retained frame on a
checker that the central archive does not already hold is queued for transfer.
A long disconnect therefore catches up fully instead of losing everything but
the newest hour.

Only substream frames are transferred, in small per-camera batches, so a slow
or interrupted link keeps the batches it already completed.

Retention is enforced centrally:

  1. Drop frames older than MAX_AGE_DAYS (the target history).
  2. If free space is below RESERVE_BYTES, drop the oldest frames until the
     reserve is restored. Retention shortens itself under pressure instead of
     filling the disk.

Frames that are already past the central age cap are never transferred; they
would be deleted immediately. Never transfers RTSP credentials.
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

MAX_AGE_DAYS = 5
RESERVE_BYTES = 8 * 1024 ** 3
SYNC_WORKERS = 4
CAMERAS_PER_BATCH = 2
FILES_PER_BATCH = 200
# A Shell Fleet batch is a single bounded download from the agent sandbox, so
# the file count stays low enough that the staged tar fits the transfer cap.
# The hub truncates a single download at 256 KiB, and frames run up to
# ~120 KiB, so four frames keep the tar comfortably under the cap. Eight
# frames often crossed it, and the discarded tar was re-sent file by file.
SHELLFLEET_FILES_PER_BATCH = 4
# One hub download is capped near 256 KiB; stay clearly below it and skip
# the tar attempt when the batch would not fit anyway.
TRANSFER_BYTES = 200 * 1024
SSH_TIMEOUT = 420
RUN_BUDGET_SECONDS = 900
# The 5-minute timer skips a run while this service is still active, so
# a large backlog must not stretch one pass past the unit timeout.
MAX_FRAMES_PER_PASS = 240
CONNECT_TIMEOUT = 25
CHECKERS = [
    ("myxuan-lan", "aibox-mxa2@100.64.0.116"),
    ("myxuan-lan", "aibox-mxa3@100.64.0.36"),
    ("giaminh-lan", "aibox-hp1@100.64.0.49"),
    ("td08-lan", "aibox-td08@100.64.0.27"),
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
    ("poseidon-lan", "vtas-aibox1@100.64.0.45"),
    ("td07-lan", "aibox-td07@100.64.0.6"),
]
ARCHIVE_REMOTE = "aibox-camera-capture/archive"

# Camera directories are IPs and frames carry an epoch in the filename. Both
# values are used to build remote paths, so anything else is rejected.
CAMERA_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")
FRAME_RE = re.compile(r"^sub-(\d+)-ok\.jpg$")


def data_dir():
    return os.environ.get("AIBOX_WEBAPP_DATA_DIR") or os.path.expanduser(
        "~/aibox-monitor/data")


def archive_dir():
    return os.path.join(data_dir(), "camera-archive")


def state_path():
    return os.path.expanduser("~/.cache/aibox-archive-sync/state.json")


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


def load_state():
    try:
        with open(state_path()) as handle:
            state = json.load(handle)
            return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(state):
    path = state_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as handle:
        json.dump(state, handle)
    os.replace(tmp, path)


def frame_epoch(name):
    """Frame timestamps are nanoseconds in the filename, set by the checker."""
    match = FRAME_RE.match(name)
    if not match:
        return None
    try:
        return int(match.group(1)) / 1e9
    except ValueError:
        return None


def ssh(target, remote_command, timeout):
    """Run a remote command through whichever transport owns the device."""
    device = target.rsplit("@", 1)[-1]
    return sft.run(device, remote_command, timeout)


def batch_limit(target, default=FILES_PER_BATCH):
    """Shell Fleet transfers are one bounded download, so keep batches small."""
    device = target.rsplit("@", 1)[-1]
    if sft.routing(device) == "shellfleet":
        return min(default, SHELLFLEET_FILES_PER_BATCH)
    return default


def remote_frames(target):
    """Map camera -> set of retained frame names, using one cheap remote call."""
    listing = ssh(
        target,
        f"cd ~/{ARCHIVE_REMOTE} 2>/dev/null || exit 0; "
        "find . -name 'sub-*-ok.jpg' -printf '%h %f %s\\n' 2>/dev/null",
        120,
    )
    frames = {}
    for line in listing.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split()
        if len(parts) != 3:
            continue
        camera = os.path.basename(parts[0])
        name = parts[1]
        try:
            size = int(parts[2])
        except ValueError:
            continue
        if not CAMERA_RE.match(camera) or frame_epoch(name) is None:
            continue
        frames.setdefault(camera, {})[name] = size
    # A failed listing (unreachable host, timeout) looks exactly like an empty
    # archive, so the caller needs the exit status to tell them apart.
    return frames, len(listing.stdout), listing.returncode == 0


def local_frames(scope, camera):
    """Frame names already archived centrally for one camera."""
    directory = os.path.join(archive_dir(), scope, camera)
    try:
        names = os.listdir(directory)
    except OSError:
        return set()
    return {name for name in names if FRAME_RE.match(name)}


def missing_frames(scope, remote, cutoff):
    """Frames on the checker that the archive lacks and retention would keep."""
    pending = []
    for camera, files in remote.items():
        have = local_frames(scope, camera)
        for name, size in files.items():
            if name in have:
                continue
            epoch = frame_epoch(name)
            if epoch is None or epoch < cutoff:
                continue
            pending.append((epoch, camera, name, size))
    # Oldest first: they are closest to being pruned on the checker.
    pending.sort()
    return pending


def take_batch(pending, camera, limit):
    """Pick frames for one download under both the count and byte limits."""
    batch = []
    used = 0
    for _epoch, cam, name, size in pending:
        if cam != camera:
            continue
        if len(batch) >= limit:
            break
        if batch and used + size > TRANSFER_BYTES:
            break
        batch.append((name, size))
        used += size
    return batch


def fetch_batch(target, scope, camera, batch, staging):
    """Copy one camera batch, falling back to single files when a tar is too big.

    Returns (placed_names, fetched_bytes, failed_names). Failed names stay in the
    caller's pending set so a short transfer can never be reported as complete.
    """
    device = target.rsplit("@", 1)[-1]
    names = [name for name, _size in batch]
    sizes = dict(batch)
    tar_path = os.path.join(staging, "batch.tar")
    projected = sum(sizes.values())
    # The hub truncates a single download near 256 KiB. A batch that would not
    # fit is retried per file instead of wasting a full staging round trip.
    # SSH streams a whole tar without the hub cap, so only Shell Fleet
    # batches need the byte estimate.
    uncapped = sft.routing(device) != "shellfleet"
    if uncapped or projected <= TRANSFER_BYTES:
        paths = " ".join(f"'{camera}/{name}'" for name in names)
        moved = sft.stream_tar(device, f"~/{ARCHIVE_REMOTE}", paths, tar_path,
                               SSH_TIMEOUT)
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
                for camera_name in os.listdir(extract):
                    if not CAMERA_RE.match(camera_name):
                        continue
                    source_dir = os.path.join(extract, camera_name)
                    if not os.path.isdir(source_dir):
                        continue
                    destination_dir = os.path.join(archive_dir(), scope, camera_name)
                    os.makedirs(destination_dir, exist_ok=True)
                    for name in os.listdir(source_dir):
                        # Failed captures carry no image data; only keep usable frames.
                        if name.startswith("sub-") and name.endswith("-ok.jpg"):
                            os.replace(os.path.join(source_dir, name),
                                       os.path.join(destination_dir, name))
                            placed.add(name)
            shutil.rmtree(extract, ignore_errors=True)
            if os.path.exists(tar_path):
                os.unlink(tar_path)
            if placed:
                return placed, moved, {n for n in names if n not in placed}

    destination_dir = os.path.join(archive_dir(), scope, camera)
    os.makedirs(destination_dir, exist_ok=True)
    placed = set()
    failed = set()
    fetched = 0
    for name, size in batch:
        # Oversized frames are not a failure: the shim retries transfer_file
        # over SSH, which is uncapped.
        local = os.path.join(staging, name)
        got = sft.transfer_file(device, f"~/{ARCHIVE_REMOTE}/{camera}/{name}", local,
                                SSH_TIMEOUT)
        if not got:
            failed.add(name)
            continue
        os.replace(local, os.path.join(destination_dir, name))
        placed.add(name)
        fetched += got
    return placed, fetched, failed


def sync_checker(target, scope, state, cutoff):
    """Reconcile one checker: transfer every missing retained frame."""
    started = time.time()
    deadline = started + RUN_BUDGET_SECONDS
    remote, moved, listed = remote_frames(target)
    if not listed:
        state[target] = {"last_run": int(time.time()), "placed": 0, "missing": 0}
        record_usage("archive", scope, target, moved, 0, time.time() - started, "failed")
        return 0, 0, 1
    pending = missing_frames(scope, remote, cutoff)
    if not pending:
        state[target] = {"last_run": int(time.time()), "placed": 0, "missing": 0}
        record_usage("archive", scope, target, moved, 0, time.time() - started, "ok")
        return 0, 0, 0

    placed = 0
    remaining = 0
    failures = 0
    result = "ok"
    while pending:
        if time.time() > deadline or placed >= MAX_FRAMES_PER_PASS:
            remaining = len(pending)
            result = "partial"
            break
        camera = pending[0][1]
        batch = take_batch(pending, camera, batch_limit(target))
        if not batch:
            # A single frame too large for one download would otherwise spin.
            remaining = len(pending)
            result = "partial"
            failures += 1
            break
        with tempfile.TemporaryDirectory(prefix="archive-batch-") as staging:
            try:
                done, size, failed = fetch_batch(target, scope, camera, batch, staging)
            except subprocess.TimeoutExpired:
                remaining = len(pending)
                result = "partial"
                failures += 1
                break
        placed += len(done)
        moved += size
        # Drop only what actually landed; anything short stays pending and is
        # reported, so a green line cannot hide a gap.
        pending = [entry for entry in pending if entry[2] not in done]
        remaining = len(pending)
        if failed:
            failures += 1
            result = "partial"
            break
    state[target] = {"last_run": int(time.time()), "placed": placed,
                     "missing": remaining}
    record_usage("archive", scope, target, moved, placed,
                 time.time() - started, result)
    return placed, remaining, failures


def iter_frames():
    """Yield (epoch, path) for every archived substream frame."""
    root = archive_dir()
    for scope in sorted(os.listdir(root)):
        scope_dir = os.path.join(root, scope)
        if not os.path.isdir(scope_dir):
            continue
        for camera in sorted(os.listdir(scope_dir)):
            camera_dir = os.path.join(scope_dir, camera)
            if not os.path.isdir(camera_dir):
                continue
            for name in os.listdir(camera_dir):
                epoch = frame_epoch(name)
                if epoch is not None:
                    yield epoch, os.path.join(camera_dir, name)


def enforce_retention():
    """Age cap first, then free up disk to the reserve, oldest frames first."""
    now = time.time()
    cutoff = now - MAX_AGE_DAYS * 86400
    frames = list(iter_frames())
    aged = [(epoch, path) for epoch, path in frames if epoch < cutoff]
    for _epoch, path in aged:
        try:
            os.unlink(path)
        except OSError:
            pass
    remaining = sorted((epoch, path) for epoch, path in frames if epoch >= cutoff)

    usage = shutil.disk_usage(data_dir())
    removed_for_space = 0
    index = 0
    # Re-measure after every unlink: free space is only known once the delete
    # lands, and a stale reading would keep deleting frames long past the point
    # the reserve was restored.
    while usage.free < RESERVE_BYTES and index < len(remaining):
        try:
            os.unlink(remaining[index][1])
            removed_for_space += 1
        except OSError:
            pass
        index += 1
        usage = shutil.disk_usage(data_dir())
    if removed_for_space:
        usage = shutil.disk_usage(data_dir())
    return len(aged), removed_for_space, usage


def budget_report():
    """Warn when a ship's recorded daily transfer exceeds its budget."""
    try:
        limit = float(os.environ.get("AIBOX_TRANSFER_DAILY_BUDGET_MB") or 0)
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
    os.makedirs(archive_dir(), exist_ok=True)
    state = load_state()
    cutoff = time.time() - MAX_AGE_DAYS * 86400
    failures = 0
    placed_total = 0
    pending_total = 0
    with ThreadPoolExecutor(max_workers=SYNC_WORKERS) as pool:
        futures = {
            pool.submit(sync_checker, target, scope, state, cutoff): (scope, target)
            for scope, target in CHECKERS
        }
        for future in as_completed(futures):
            scope, target = futures[future]
            try:
                placed, remaining, errors = future.result()
                placed_total += placed
                pending_total += remaining
                if remaining or errors:
                    failures += 1
            except Exception as error:
                failures += 1
                print(f"archive sync error: {target}: {type(error).__name__}", flush=True)
                record_usage("archive", scope, target, 0, 0, 0, "failed")
    save_state(state)

    aged, for_space, usage = enforce_retention()
    if placed_total or pending_total or aged or for_space or failures:
        print(
            f"archive sync: +{placed_total} frames, {pending_total} still missing, "
            f"age-pruned {aged}, space-pruned {for_space}, "
            f"free {usage.free // 1048576} MiB, errors {failures}",
            flush=True,
        )
    budget_report()
    return 1 if failures == len(CHECKERS) else 0


if __name__ == "__main__":
    sys.exit(main())
