"""Device identity for the Shell Fleet migration.

The tailnet IP stays the stable internal identity key: every existing service,
history file and UI row is already keyed by it. After migration it is used only
as a key, never as a connection destination.

Agent IDs below were verified against the live hub inventory on 2026-11-12.
Two devices do not follow the `aibox-<name>` convention and are easy to get
wrong: MXA2 is `vta-portmaster2`, TD-07 is `aibox7`. The hub's `source_ip` is
the public egress address, so hostname/agent id is the only usable join key.

Poseidon has no agent. It is reported `unregistered`, never `offline`.
"""

import json
import os

MONITOR_CONFIG = os.environ.get(
    "AIBOX_MONITOR_CONFIG", "/home/boxtest2/aibox-monitor/config.json"
)

# ip -> Shell Fleet agent id. Absent entry means "no agent enrolled".
AGENTS = {
    "100.64.0.49": "aibox-hp1",
    "100.64.0.92": "aibox-hp2",
    "100.64.0.96": "aibox-hp3",
    "100.64.0.97": "aibox-hp4",
    "100.64.0.65": "aibox-mxa1",
    "100.64.0.116": "vta-portmaster2",
    "100.64.0.36": "aibox-mxa3",
    "100.64.0.44": "aibox-starcity",
    "100.64.0.80": "aibox-oceanus",
    "100.64.0.85": "aibox-neptune",
    "100.64.0.1": "aibox-th04",
    "100.64.0.81": "aibox-th05",
    "100.64.0.82": "aibox-th06",
    "100.64.0.6": "aibox7",
    "100.64.0.27": "aibox-td08",
    "100.64.0.104": "aibox-th07",
    "100.64.0.121": "aibox-td09",
    "100.64.0.122": "aibox-th08",
    "100.64.0.123": "aibox-th09",
}

# Archive scope per device.
SCOPES = {
    "100.64.0.49": "giaminh-lan",
    "100.64.0.92": "giaminh-lan",
    "100.64.0.96": "giaminh-lan",
    "100.64.0.97": "giaminh-lan",
    "100.64.0.65": "myxuan-lan",
    "100.64.0.116": "myxuan-lan",
    "100.64.0.36": "myxuan-lan",
    "100.64.0.44": "starcity-lan",
    "100.64.0.80": "oceanus-lan",
    "100.64.0.85": "neptune-lan",
    "100.64.0.45": "poseidon-lan",
    "100.64.0.1": "th04-lan",
    "100.64.0.81": "th05-lan",
    "100.64.0.82": "th06-lan",
    "100.64.0.6": "td07-lan",
    "100.64.0.27": "td08-lan",
    "100.64.0.104": "th07-lan",
    "100.64.0.121": "td09-lan",
    "100.64.0.122": "th08-lan",
    "100.64.0.123": "th09-lan",
}

# Unix account that owns the capture tree on each device.
USERS = {
    "100.64.0.49": "aibox-hp1",
    "100.64.0.92": "aibox-hp2",
    "100.64.0.96": "aibox-hp3",
    "100.64.0.97": "aibox-hp4",
    "100.64.0.65": "aibox-mxa1",
    "100.64.0.116": "aibox-mxa2",
    "100.64.0.36": "aibox-mxa3",
    "100.64.0.44": "aibox-starcity",
    "100.64.0.80": "aibox-oceanus",
    "100.64.0.85": "aibox-neptune",
    "100.64.0.45": "vtas-aibox1",
    "100.64.0.1": "aibox-th04",
    "100.64.0.81": "aibox-th05",
    "100.64.0.82": "aibox-th06",
    "100.64.0.6": "aibox-td07",
    "100.64.0.27": "aibox-td08",
    "100.64.0.104": "aibox-th07",
    "100.64.0.121": "aibox-td09",
    "100.64.0.122": "aibox-th08",
    "100.64.0.123": "aibox-th09",
}


def _load_monitor_config():
    try:
        with open(MONITOR_CONFIG, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def build_devices(config=None):
    """Return {ip: device} covering every monitored AIBOX plus known scopes."""
    config = config if config is not None else _load_monitor_config()
    devices = {}
    for box in config.get("aiboxes", []) or []:
        ip = box.get("ip")
        if not ip:
            continue
        user = USERS.get(ip) or box.get("user") or ""
        devices[ip] = {
            "ip": ip,
            "name": box.get("name") or ip,
            "user": user,
            "home": "/home/" + user if user else "",
            "agent": AGENTS.get(ip),
            "scope": SCOPES.get(ip),
        }
    for ip, scope in SCOPES.items():
        devices.setdefault(
            ip,
            {
                "ip": ip,
                "name": ip,
                "user": USERS.get(ip, ""),
                "home": "/home/" + USERS[ip] if USERS.get(ip) else "",
                "agent": AGENTS.get(ip),
                "scope": scope,
            },
        )
    return devices


DEVICES = build_devices()


def by_ip(ip):
    return DEVICES.get(ip)


def by_scope(scope):
    for device in DEVICES.values():
        if device.get("scope") == scope:
            return device
    return None


def resolve(key):
    """Accept an IP, an agent id, a scope, a device name, or a unix user."""
    if not key:
        return None
    key = str(key).strip()
    direct = DEVICES.get(key)
    if direct:
        return direct
    lowered = key.lower()
    for device in DEVICES.values():
        for field in ("agent", "scope", "name", "user"):
            if (device.get(field) or "").lower() == lowered:
                return device
    return None