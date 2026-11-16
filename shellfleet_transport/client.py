"""Client used by local consumers to talk to the Shell Fleet adapter."""

import json
import os
import socket

DEFAULT_SOCKET = os.environ.get(
    "SHELLFLEET_SOCKET",
    os.path.expanduser("~/.local/state/aibox-shellfleet/adapter.sock"),
)


class AdapterError(Exception):
    def __init__(self, reason, detail=""):
        super().__init__("%s: %s" % (reason, detail) if detail else reason)
        self.reason = reason
        self.detail = detail


def call(request, socket_path=None, timeout=900):
    path = socket_path or DEFAULT_SOCKET
    payload = (json.dumps(request) + "\n").encode()
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(path)
        sock.sendall(payload)
        buffer = b""
        while b"\n" not in buffer:
            chunk = sock.recv(65536)
            if not chunk:
                break
            buffer += chunk
    finally:
        sock.close()
    if not buffer:
        raise AdapterError("adapter-unavailable", path)
    reply = json.loads(buffer.split(b"\n", 1)[0])
    if not reply.get("ok"):
        raise AdapterError(reply.get("reason") or "error", reply.get("error") or "")
    return reply.get("result")


def status(device, **kwargs):
    return call({"op": "status", "device": device}, **kwargs)


def statuses(**kwargs):
    return call({"op": "statuses"}, **kwargs)


def health(**kwargs):
    return call({"op": "health"}, **kwargs)


def execute(device, script, run_as=None, timeout=180, session_timeout=30,
            privileged=False, **kwargs):
    return call(
        {
            "op": "exec",
            "device": device,
            "script": script,
            "run_as": run_as,
            "timeout": timeout,
            "session_timeout": session_timeout,
            "privileged": privileged,
        },
        **kwargs
    )


def download(device, path, destination, timeout=600, **kwargs):
    return call(
        {"op": "download", "device": device, "path": path,
         "destination": destination, "timeout": timeout},
        **kwargs
    )


def is_migrated(device, **kwargs):
    """True when Shell Fleet is authoritative for this device right now."""
    try:
        record = status(device, **kwargs)
    except AdapterError:
        return False
    return bool(record and record.get("authoritative"))