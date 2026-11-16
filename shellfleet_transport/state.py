"""Availability state derived only from observed hub inventory.

The hub snapshot carries no last-seen timestamp, so `statusSince` always starts
at the local observation that established the state. Nothing here infers what
happened before the first observation.
"""

import json
import logging
import os
import tempfile
import time

log = logging.getLogger("shellfleet.state")

STATUS_ONLINE = "online"
STATUS_OFFLINE = "offline"
STATUS_UNKNOWN = "unknown"
STATUS_UNREGISTERED = "unregistered"


def _iso(epoch):
    if epoch is None:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(epoch)) + "Z"


class AvailabilityStore:
    def __init__(self, path, devices, rollout, inventory_ttl=60.0):
        self.path = path
        self.devices = devices
        self.rollout = set(rollout)
        self.inventory_ttl = inventory_ttl
        self.records = self._load()
        self._last_inventory_at = 0.0

    # -- persistence -------------------------------------------------
    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError):
            return {}
        records = payload.get("devices") if isinstance(payload, dict) else None
        return records if isinstance(records, dict) else {}

    def _save(self):
        directory = os.path.dirname(self.path)
        os.makedirs(directory, exist_ok=True)
        payload = {"updatedAt": _iso(time.time()), "devices": self.records}
        handle = tempfile.NamedTemporaryFile(
            "w", dir=directory, prefix=".availability-", suffix=".json", delete=False
        )
        try:
            json.dump(payload, handle, indent=1, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        finally:
            handle.close()
        os.replace(handle.name, self.path)

    # -- derivation --------------------------------------------------
    def _classify(self, device, inventory, connected, inventory_age):
        agent_id = device.get("agent")
        if not agent_id:
            return STATUS_UNREGISTERED, "no-agent-enrolled"
        if not connected:
            return STATUS_UNKNOWN, "hub-unavailable"
        if inventory_age is None or inventory_age > self.inventory_ttl:
            return STATUS_UNKNOWN, "stale-inventory"
        agent = inventory.get(agent_id)
        if agent is None:
            return STATUS_UNKNOWN, "agent-missing"
        online = agent.get("online")
        if online is True:
            return STATUS_ONLINE, "agent-online"
        if online is False:
            return STATUS_OFFLINE, "agent-offline"
        return STATUS_UNKNOWN, "agent-state-missing"

    def observe(self, inventory, connected, inventory_at, now=None):
        """Apply one inventory observation to every known device."""
        now = now or time.time()
        age = None if not inventory_at else now - inventory_at
        changed = False
        for ip, device in self.devices.items():
            status, reason = self._classify(device, inventory, connected, age)
            previous = self.records.get(ip) or {}
            same = previous.get("status") == status and previous.get("reason") == reason
            record = {
                "device": ip,
                "name": device.get("name") or ip,
                "agentId": device.get("agent"),
                "status": status,
                "reason": reason,
                "observedAt": now,
                "observedAtIso": _iso(now),
                "statusSince": previous.get("statusSince") if same else now,
                "statusSinceIso": previous.get("statusSinceIso") if same else _iso(now),
                "source": "shellfleet",
                "sourceEpoch": previous.get("sourceEpoch") or now,
                "inventoryAge": None if age is None else round(age, 1),
                "authoritative": ip in self.rollout,
            }
            if not same:
                record["previousStatus"] = previous.get("status")
                changed = True
            self.records[ip] = record
        if changed:
            try:
                self._save()
            except OSError as exc:
                log.warning("state persist failed: %s", type(exc).__name__)
        return self.records

    # -- reads ------------------------------------------------------
    def status(self, ip):
        record = self.records.get(ip)
        if not record:
            device = self.devices.get(ip)
            if not device:
                return None
            return {
                "device": ip,
                "name": device.get("name") or ip,
                "agentId": device.get("agent"),
                "status": STATUS_UNKNOWN,
                "reason": "not-observed",
                "observedAt": None,
                "statusSince": None,
                "source": "shellfleet",
                "sourceEpoch": None,
                "authoritative": ip in self.rollout,
                "inventoryAge": None,
            }
        return record

    def all(self):
        return {ip: self.status(ip) for ip in self.devices}