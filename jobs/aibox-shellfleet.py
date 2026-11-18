"""Bridge from the existing monitoring scripts to the Shell Fleet adapter.

Consumers keep their current shape (`run()` returns an object with
`returncode`/`stdout`). Shell Fleet is the primary transport for devices in the
adapter rollout. When Shell Fleet cannot serve a device (adapter unreachable,
agent offline, or an exec/transfer failure) the call falls back to the legacy
Tailscale SSH path. The fallback is explicit and logged, never silent, so
availability stays Shell-Fleet-primary while connectivity keeps working.

Devices outside the rollout keep their legacy SSH path untouched.
"""

import json
import os
import shlex
import shutil
import sys
import tarfile
import time

import subprocess

# One transfer cannot exceed this many uncompressed bytes. Callers also keep
# their own per-batch file counts so a batch normally lands well under it.
MAX_TRANSFER_BYTES = 8 * 1024 * 1024
STAGING_SWEEP_SECONDS = 1800

MONITOR_CONFIG = os.environ.get(
    "AIBOX_MONITOR_CONFIG", "/home/boxtest2/aibox-monitor/config.json"
)
PACKAGE_ROOT = os.environ.get(
    "AIBOX_SHELLFLEET_PACKAGE", "/home/boxtest2/aibox-monitor"
)
# Absolute path of each agent's file sandbox. Verified per device before use.
SANDBOX = {
    "100.64.0.6": "/home/aibox-td07/.shellfleet-files",
    "100.64.0.27": "/home/aibox-td08/.shellfleet-files",
    "100.64.0.36": "/home/aibox-mxa3/.shellfleet-files",
    "100.64.0.44": "/home/aibox-starcity/.shellfleet-files",
    "100.64.0.49": "/home/aibox-hp1/.shellfleet-files",
    "100.64.0.65": "/home/aibox-mxa1/.shellfleet-files",
    "100.64.0.80": "/home/aibox-oceanus/.shellfleet-files",
    "100.64.0.81": "/home/aibox-th05/.shellfleet-files",
    "100.64.0.85": "/home/aibox-neptune/.shellfleet-files",
    "100.64.0.92": "/home/aibox-hp2/.shellfleet-files",
    "100.64.0.96": "/home/aibox-hp3/.shellfleet-files",
    "100.64.0.97": "/home/aibox-hp4/.shellfleet-files",
    "100.64.0.116": "/home/aibox-mxa2/.shellfleet-files",
    "100.64.0.121": "/home/aibox-td09/.shellfleet-files",
    "100.64.0.1": "/home/aibox-th04/.shellfleet-files",
    "100.64.0.82": "/home/aibox-th06/.shellfleet-files",
    "100.64.0.104": "/home/aibox-th07/.shellfleet-files",
    "100.64.0.122": "/home/aibox-th08/.shellfleet-files",
    "100.64.0.123": "/home/aibox-th09/.shellfleet-files",
}
STAMP_RE = "aibox-sf-%d-%d"


class Result(object):
    """The subset of subprocess.CompletedProcess the consumers actually read."""

    def __init__(self, returncode, stdout=b"", stderr=b""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


_config_cache = {"at": 0.0, "users": {}}


def _users():
    now = time.time()
    if now - _config_cache["at"] < 60 and _config_cache["users"]:
        return _config_cache["users"]
    users = {}
    try:
        with open(MONITOR_CONFIG, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        for box in data.get("aiboxes", []) or []:
            if box.get("ip") and box.get("user"):
                users[box["ip"]] = box["user"]
    except (OSError, ValueError):
        users = {}
    if users:
        _config_cache["at"] = now
        _config_cache["users"] = users
    return users


def user_for(device):
    return _users().get(device)


def _client():
    """Import the adapter client lazily so a broken install cannot break SSH."""
    try:
        if PACKAGE_ROOT not in os.sys.path:
            os.sys.path.insert(0, PACKAGE_ROOT)
        from shellfleet_transport import client
        return client
    except Exception:
        return None


def status(device, timeout=10):
    client = _client()
    if client is None:
        return None
    try:
        return client.status(device, timeout=timeout)
    except Exception:
        return None


ROLLOUT_FILE = os.environ.get(
    "AIBOX_SHELLFLEET_ROLLOUT_FILE", "/home/boxtest2/.config/aibox-shellfleet/env"
)
_rollout_cache = {"at": 0.0, "ips": frozenset()}


def rollout():
    """Devices this install has migrated, readable while the adapter is down."""
    now = time.time()
    if _rollout_cache["ips"] and now - _rollout_cache["at"] < 60:
        return _rollout_cache["ips"]
    raw = os.environ.get("SHELLFLEET_ROLLOUT", "")
    if not raw:
        try:
            with open(ROLLOUT_FILE, "r", encoding="utf-8") as handle:
                for line in handle:
                    if line.startswith("SHELLFLEET_ROLLOUT="):
                        raw = line.split("=", 1)[1].strip()
                        break
        except OSError:
            raw = ""
    ips = frozenset(part.strip() for part in raw.split(",") if part.strip())
    _rollout_cache["at"] = now
    _rollout_cache["ips"] = ips
    return ips


def migrated(device):
    return device in rollout()


def routing(device):
    """`shellfleet` when the adapter owns this device, otherwise `legacy`."""
    if migrated(device):
        # Shell Fleet is primary for migrated devices. The transport functions
        # below may use an explicit, logged Tailscale fallback when Shell Fleet
        # cannot serve the call; routing itself stays Shell-Fleet-primary.
        return "shellfleet"
    record = status(device)
    if record and record.get("authoritative"):
        return "shellfleet"
    return "legacy"


def online(device):
    record = status(device)
    return bool(record and record.get("authoritative") and record.get("status") == "online")


def run(device, command, timeout, user=None):
    """Execute a remote shell command whose `~` must be the device user's home."""
    mode = routing(device)
    if mode == "legacy":
        target = _legacy_target(device)
        return _legacy_run(target, command, timeout)

    run_as = user or user_for(device)
    client = _client()
    if client is None:
        _note_fallback(device, "run")
        return _legacy_run(_legacy_target(device), command, timeout)
    if not online(device):
        # Shell Fleet cannot observe the device right now; use the explicit
        # Tailscale fallback rather than failing closed.
        _note_fallback(device, "run")
        return _legacy_run(_legacy_target(device), command, timeout)
    try:
        result = client.execute(device, command, run_as=run_as, timeout=timeout)
    except Exception:
        _note_fallback(device, "run")
        return _legacy_run(_legacy_target(device), command, timeout)
    return Result(
        int(result.get("exit_code") or 0),
        (result.get("stdout") or "").encode("utf-8"),
        (result.get("stderr") or "").encode("utf-8"),
    )


def _cd(remote_cwd):
    """`~` must resolve to the *device user's* home, not the adapter's."""
    if remote_cwd == "~":
        return "cd ~ 2>/dev/null"
    if remote_cwd.startswith("~/"):
        # A bare `~` is expanded by the *device* shell. `"$HOME"` would be
        # expanded by boxtest2's shell first and point at the wrong account.
        return "cd ~/%s 2>/dev/null" % shlex.quote(remote_cwd[2:])
    return "cd %s 2>/dev/null" % shlex.quote(remote_cwd)


def stream_tar(device, remote_cwd, paths, destination, timeout):
    """Copy `paths` (relative to `remote_cwd`) from the device into `destination`.

    Shell Fleet is primary: the tar is staged in the agent sandbox, downloaded
    as one bounded file, then removed. When Shell Fleet cannot serve the call,
    fall back to the legacy Tailscale SSH stream (explicit and logged).
    """
    mode = routing(device)
    if mode == "legacy":
        return _legacy_stream_tar(_legacy_target(device), remote_cwd, paths, destination, timeout)

    size = _shellfleet_stream_tar(device, remote_cwd, paths, destination, timeout)
    if size:
        return size
    _note_fallback(device, "stream_tar")
    return _legacy_stream_tar(_legacy_target(device), remote_cwd, paths, destination, timeout)


def _shellfleet_stream_tar(device, remote_cwd, paths, destination, timeout):
    sandbox = SANDBOX.get(device)
    run_as = user_for(device)
    client = _client()
    if client is None or not sandbox or not run_as or not online(device):
        return 0

    _sweep_staging(device, sandbox)

    name = "tar-%d-%d.tar" % (int(time.time()), os.getpid())
    staged = os.path.join(sandbox, name)
    # This command runs as root, whose HOME is unset, so `~` must be resolved
    # from the device user's passwd entry rather than inherited from the shell.
    address = "/%s" % remote_cwd[2:] if remote_cwd.startswith("~/") else ""
    if remote_cwd == "~":
        address = ""
    build = (
        'H=$(getent passwd %s | cut -d: -f6); cd "$H"%s 2>/dev/null || exit 3; '
        "tar -cf %s --no-recursion %s 2>/dev/null"
        % (shlex.quote(run_as), shlex.quote(address), shlex.quote(staged), paths)
    )
    prepared = _shellfleet_root(device, build, timeout)
    if prepared != 0:
        return 0
    try:
        client.download(device, name, destination, timeout=timeout)
    except Exception:
        _shellfleet_root(device, "rm -f %s" % shlex.quote(staged), 30)
        return 0
    _shellfleet_root(device, "rm -f %s" % shlex.quote(staged), 30)
    try:
        size = os.path.getsize(destination)
    except OSError:
        return 0
    if size > MAX_TRANSFER_BYTES:
        # Oversized staging is a bug in the caller's batching, not a transfer
        # to keep: drop it so nothing downstream extracts a partial archive.
        try:
            os.unlink(destination)
        except OSError:
            pass
        return 0
    return size


class UnsafeArchive(Exception):
    """The staged tar contains something the archive never produces."""


def safe_extract(tar_path, destination):
    """Extract only regular files whose names stay inside `destination`.

    The old code ran `tar -xf`, which honours absolute paths, `..`, and links.
    A checker is a remote host, so nothing it sends is trusted.
    """
    root = os.path.realpath(destination)
    os.makedirs(root, exist_ok=True)
    with tarfile.open(tar_path, "r:") as handle:
        for info in handle.getmembers():
            name = info.name
            parts = name.split("/")
            if name.startswith("/") or os.path.isabs(name):
                raise UnsafeArchive("absolute path: %s" % name)
            if any(part in ("", "..") for part in parts):
                raise UnsafeArchive("traversal: %s" % name)
            if not info.isfile():
                raise UnsafeArchive("non-regular member: %s" % name)
            target = os.path.realpath(os.path.join(root, name))
            if not target.startswith(root + os.sep):
                raise UnsafeArchive("escapes destination: %s" % name)
            source = handle.extractfile(info)
            if source is None:
                raise UnsafeArchive("unreadable member: %s" % name)
            parent = os.path.dirname(target)
            if parent:
                os.makedirs(parent, exist_ok=True)
            partial = target + ".part"
            with source, open(partial, "wb") as out:
                shutil.copyfileobj(source, out)
            os.replace(partial, target)
    return True


_swept = {}

_FALLBACK_NOTED = {}
FALLBACK_NOTE_SECONDS = 300


def _note_fallback(device, op):
    """Log (throttled) that a call is using the Tailscale fallback.

    The fallback is explicit, never silent: availability stays Shell-Fleet-
    primary while connectivity keeps working over Tailscale SSH.
    """
    now = time.time()
    key = (device, op)
    if now - _FALLBACK_NOTED.get(key, 0) < FALLBACK_NOTE_SECONDS:
        return
    _FALLBACK_NOTED[key] = now
    try:
        sys.stderr.write(
            "aibox-shellfleet: %s using tailscale fallback for %s\n" % (op, device)
        )
        sys.stderr.flush()
    except Exception:
        pass


def _sweep_staging(device, sandbox, older_than=STAGING_SWEEP_SECONDS):
    """Drop staging left behind by an earlier crashed run."""
    now = time.time()
    if now - _swept.get(device, 0) < STAGING_SWEEP_SECONDS:
        return
    _swept[device] = now
    _shellfleet_root(
        device,
        "find %s -maxdepth 1 -type f -name 'tar-*.tar' -mmin +%d -delete 2>/dev/null"
        % (shlex.quote(sandbox), max(1, older_than // 60)),
        30,
    )


def transfer_file(device, remote_path, destination, timeout, run_as=None):
    """Copy one file from the device.

    Shell Fleet is primary: the file is staged in the agent sandbox and
    downloaded. The hub truncates a single download at roughly 256 KiB, so
    batching several files into one archive only works while it stays small.
    When Shell Fleet cannot serve the call, fall back to the legacy Tailscale
    SSH copy (explicit and logged).
    """
    if routing(device) == "legacy":
        return _legacy_transfer_file(_legacy_target(device), remote_path, destination, timeout)
    size = _shellfleet_transfer_file(device, remote_path, destination, timeout, run_as)
    if size:
        return size
    _note_fallback(device, "transfer_file")
    return _legacy_transfer_file(_legacy_target(device), remote_path, destination, timeout)


def _shellfleet_transfer_file(device, remote_path, destination, timeout, run_as=None):
    sandbox = SANDBOX.get(device)
    user = run_as or user_for(device)
    client = _client()
    if client is None or not sandbox or not user or not online(device):
        return 0
    name = "one-%d-%d" % (int(time.time() * 1000), os.getpid())
    staged = os.path.join(sandbox, name)
    quote = shlex.quote
    command = (
        'H=$(getent passwd %s | cut -d: -f6); cd "$H" 2>/dev/null || exit 3; '
        "cp -f -- %s %s 2>/dev/null"
        % (quote(user), quote(remote_path[2:] if remote_path.startswith("~/") else remote_path),
           quote(staged))
    )
    if _shellfleet_root(device, command, timeout) != 0:
        return 0
    try:
        client.download(device, name, destination, timeout=timeout)
    except Exception:
        _shellfleet_root(device, "rm -f %s" % quote(staged), 30)
        return 0
    _shellfleet_root(device, "rm -f %s" % quote(staged), 30)
    try:
        return os.path.getsize(destination)
    except OSError:
        return 0


# -- legacy helpers ----------------------------------------------------
def _legacy_target(device):
    """Resolve the SSH target the old code used, keeping its exact format."""
    user = user_for(device)
    if not user:
        return device
    return "%s@%s" % (user, device)


def _legacy_run(target, command, timeout):
    cmd = (
        "ssh -o BatchMode=yes -o ConnectTimeout=25 "
        "-o StrictHostKeyChecking=accept-new %s %s"
        % (target, shlex.quote(command))
    )
    try:
        done = subprocess.run(cmd, shell=True, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=timeout)
    except subprocess.TimeoutExpired:
        return Result(255)
    return Result(done.returncode, done.stdout, b"")


def _legacy_stream_tar(target, remote_cwd, paths, destination, timeout):
    remote = "%s || exit 0; tar -cf - --no-recursion %s 2>/dev/null" % (
        _cd(remote_cwd), paths,
    )
    cmd = (
        "ssh -o BatchMode=yes -o ConnectTimeout=25 "
        "-o StrictHostKeyChecking=accept-new %s %s"
        % (target, shlex.quote(remote))
    )
    try:
        with open(destination, "wb") as out:
            done = subprocess.run(cmd, shell=True, stdout=out,
                                  stderr=subprocess.DEVNULL, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        return 0
    if done.returncode != 0:
        return 0
    try:
        return os.path.getsize(destination)
    except OSError:
        return 0


def _legacy_transfer_file(target, remote_path, destination, timeout):
    """Copy one file over Tailscale SSH, atomically (`.part` then replace)."""
    if remote_path.startswith("~/"):
        remote = "cat ~/%s" % shlex.quote(remote_path[2:])
    else:
        remote = "cat %s" % shlex.quote(remote_path)
    cmd = (
        "ssh -o BatchMode=yes -o ConnectTimeout=25 "
        "-o StrictHostKeyChecking=accept-new %s %s"
        % (target, shlex.quote(remote))
    )
    partial = destination + ".part"
    try:
        with open(partial, "wb") as out:
            done = subprocess.run(cmd, shell=True, stdout=out,
                                  stderr=subprocess.DEVNULL, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        try:
            os.unlink(partial)
        except OSError:
            pass
        return 0
    if done.returncode != 0:
        try:
            os.unlink(partial)
        except OSError:
            pass
        return 0
    try:
        os.replace(partial, destination)
        return os.path.getsize(destination)
    except OSError:
        return 0


def list_files(device, subdir=""):
    """List one sandbox directory through the hub file API.

    The agent answers file operations without starting a shell session, so
    this still works while command execution times out. Returns the agent's
    entry list, or None when the hub cannot serve the call.
    """
    client = _client()
    sandbox = SANDBOX.get(device)
    if client is None or not sandbox or not online(device):
        return None
    try:
        return client.list_files(device, subdir)
    except Exception:
        return None


def download_file(device, relative_path, destination, timeout=90):
    """Download one sandbox file through the hub file API (no shell needed)."""
    client = _client()
    sandbox = SANDBOX.get(device)
    if client is None or not sandbox or not online(device):
        return 0
    try:
        client.download(device, relative_path, destination, timeout=timeout)
    except Exception:
        return 0
    try:
        return os.path.getsize(destination)
    except OSError:
        return 0


def _shellfleet_root(device, command, timeout):
    client = _client()
    if client is None:
        return 255
    try:
        result = client.execute(device, command, privileged=True, timeout=timeout)
    except Exception:
        return 255
    return int(result.get("exit_code") or 0)