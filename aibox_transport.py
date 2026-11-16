"""Route AIBOX monitor operations through the Shell Fleet adapter.

The monitor keeps its legacy SSH path for devices outside the migration
rollout. A device inside the rollout is always served by the adapter, even
when the adapter is down: falling back to SSH would make the reported
availability and the real transport disagree.
"""

import os
import shlex
import time

LIB_DIR = os.environ.get("AIBOX_SHELLFLEET_LIB", "/usr/local/lib/aibox-shellfleet")
ROLLOUT_FILE = os.environ.get(
    "AIBOX_SHELLFLEET_ROLLOUT_FILE", "/home/boxtest2/.config/aibox-shellfleet/env"
)

try:
    if LIB_DIR not in os.sys.path:
        os.sys.path.insert(0, LIB_DIR)
    import aibox_shellfleet as _sft
except Exception:  # a broken install must not stop legacy monitoring
    _sft = None

_rollout_cache = {"at": 0.0, "ips": frozenset()}


def _rollout():
    """Static list of migrated devices, readable without the adapter running."""
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
    return device in _rollout()


def available():
    return _sft is not None


def state(device):
    """`online`, `offline`, `unregistered`, or `unknown` for migrated devices."""
    if not available():
        return "unknown"
    try:
        record = _sft.status(device)
    except Exception:
        return "unknown"
    if not record:
        return "unknown"
    value = record.get("status")
    if value in ("online", "offline", "unregistered"):
        return value
    return "unknown"


class Result(object):
    """The subset of subprocess.CompletedProcess the monitor reads."""

    def __init__(self, returncode, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def run(user, device, argv, timeout, stdin_text=None):
    """Run one command on a migrated device as its own AIBOX user."""
    if not available():
        return Result(255, "", "shellfleet adapter unavailable")
    if state(device) != "online":
        return Result(255, "", "device not observable through shellfleet")

    command = shlex.join(argv)
    if stdin_text is not None:
        marker = "SF_STDIN_%s" % os.getpid()
        while marker in stdin_text:
            marker += "X"
        command = "%s <<'%s'\n%s\n%s" % (command, marker, stdin_text, marker)

    try:
        result = _sft.run(device, command, timeout=timeout, user=user)
    except Exception as exc:
        return Result(255, "", "shellfleet execute failed: %s" % exc)

    stdout = result.stdout
    stderr = result.stderr
    if isinstance(stdout, bytes):
        stdout = stdout.decode("utf-8", "replace")
    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", "replace")
    return Result(int(result.returncode or 0), stdout or "", stderr or "")