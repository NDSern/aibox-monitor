"""Unix-socket adapter service.

Consumers send one JSON object per line and receive one JSON object per line.
The socket lives in the adapter owner's state directory (0700); root-owned
callers reach it through normal filesystem privileges.
"""

import json
import logging
import os
import socketserver
import threading
import time

from . import identity
from .core import HubConnection, TransportError
from .state import AvailabilityStore

log = logging.getLogger("shellfleet.service")

STATE_DIR = os.environ.get(
    "SHELLFLEET_STATE_DIR",
    os.path.expanduser("~/.local/state/aibox-shellfleet"),
)
SOCKET_PATH = os.path.join(STATE_DIR, "adapter.sock")
AVAILABILITY_PATH = os.path.join(STATE_DIR, "availability.json")
CONFIG_PATH = os.environ.get(
    "SHELLFLEET_CONFIG",
    os.path.expanduser("~/.config/aibox-shellfleet/env"),
)

DEFAULT_ROLLOUT = "100.64.0.85"
# Sized for the migrated fleet: snapshot (6 workers) + archive (4) + monitor +
# connection-collector fire concurrently at each minute boundary. 8 slots made
# the adapter reject the overlap with TransportError('busy'), failing transfers.
MAX_CONCURRENT_EXEC = 24
# A (device, operation) pair that repeatedly fails to finish is put on a
# cooldown. Callers then get an immediate "degraded" error and fall back to SSH
# instead of paying the full timeout on every archive/snapshot pass. The
# cooldown is per operation, not per device: a stalled privileged exec must not
# disable plain exec or downloads for the same box.
DEGRADED_SECONDS = 600


def load_settings(path=CONFIG_PATH):
    values = {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return values


class Adapter:
    def __init__(self, settings):
        self.settings = settings
        rollout = settings.get("SHELLFLEET_ROLLOUT", DEFAULT_ROLLOUT)
        self.rollout = [item.strip() for item in rollout.split(",") if item.strip()]
        self.store = AvailabilityStore(
            AVAILABILITY_PATH,
            identity.DEVICES,
            self.rollout,
            inventory_ttl=float(settings.get("SHELLFLEET_INVENTORY_TTL", "60")),
        )
        self.hub = HubConnection(
            settings.get("SHELLFLEET_USER", ""),
            settings.get("SHELLFLEET_PASSWORD", ""),
            hub=settings.get("SHELLFLEET_HUB", "https://aiboxmng.vnstech.cloud"),
            inventory_ttl=float(settings.get("SHELLFLEET_INVENTORY_TTL", "60")),
        )
        self._exec_slots = threading.Semaphore(MAX_CONCURRENT_EXEC)
        self._degraded = {}
        self._degraded_lock = threading.Lock()

    def start(self):
        self.hub.start()
        threading.Thread(target=self._observe_loop, name="sf-observe", daemon=True).start()

    def _observe_loop(self):
        while True:
            try:
                inventory, observed_at, connected = self.hub.agents()
                self.store.observe(inventory, connected, observed_at)
            except Exception as exc:  # pragma: no cover
                log.warning("observation failed: %s", type(exc).__name__)
            time.sleep(5.0)

    # -- operations --------------------------------------------------
    def _degraded_key(self, ip, op, privileged=False):
        """Cooldown bucket: one per (device, operation, identity)."""
        if op == "exec":
            return (ip, "exec-root" if privileged else "exec-user")
        return (ip, op)

    def _check_degraded(self, key):
        with self._degraded_lock:
            until = self._degraded.get(key, 0)
        if until > time.time():
            raise TransportError("degraded", "recent timeouts")

    def _mark_degraded(self, key, reason):
        with self._degraded_lock:
            self._degraded[key] = time.time() + DEGRADED_SECONDS
        log.warning(
            "device %s op %s degraded for %ss after %s",
            key[0],
            key[1],
            DEGRADED_SECONDS,
            reason,
        )

    def status(self, key):
        device = identity.resolve(key)
        if not device:
            raise TransportError("unknown-device", str(key))
        return self.store.status(device["ip"])

    def statuses(self):
        return self.store.all()

    def health(self):
        inventory, observed_at, connected = self.hub.agents()
        return {
            "connected": connected,
            "agents": len(inventory),
            "inventoryAge": self.hub.snapshot_age(),
            "rollout": self.rollout,
            "pid": os.getpid(),
        }

    def execute(self, key, script, run_as=None, timeout=180, session_timeout=30, privileged=False):
        device = identity.resolve(key)
        if not device:
            raise TransportError("unknown-device", str(key))
        agent = device.get("agent")
        if not agent:
            raise TransportError("unregistered", "no agent enrolled")
        # privileged operations run as root and must not be downgraded to the
        # device user; run_as is ignored in that case.
        user = None if privileged else (run_as or device.get("user") or None)
        ip = device.get("ip") or str(key)
        degraded = self._degraded_key(ip, "exec", privileged=privileged)
        self._check_degraded(degraded)
        if not self._exec_slots.acquire(blocking=False):
            raise TransportError("busy", "execution slots exhausted")
        try:
            try:
                result = self.hub.execute(
                    agent,
                    script,
                    run_as=user,
                    timeout=timeout,
                    session_timeout=session_timeout,
                    privileged=privileged,
                )
            except TransportError as exc:
                if exc.reason in ("command-timeout", "agent-unreachable"):
                    self._mark_degraded(degraded, exc.reason)
                raise
            with self._degraded_lock:
                self._degraded.pop(degraded, None)
            return result
        finally:
            self._exec_slots.release()

    def download(self, key, path, destination, timeout=600):
        device = identity.resolve(key)
        if not device:
            raise TransportError("unknown-device", str(key))
        agent = device.get("agent")
        if not agent:
            raise TransportError("unregistered", "no agent enrolled")
        ip = device.get("ip") or str(key)
        degraded = self._degraded_key(ip, "download")
        self._check_degraded(degraded)
        try:
            size = self.hub.download(agent, path, destination, timeout=timeout)
        except TransportError as exc:
            # transfer-failed is usually a size/truncation artifact, not a device
            # fault; the shim retries those over ssh, so it must not trip the
            # cooldown and block the working downloads that follow.
            if exc.reason in ("command-timeout", "agent-unreachable"):
                self._mark_degraded(degraded, exc.reason)
            raise
        with self._degraded_lock:
            self._degraded.pop(degraded, None)
        return {"bytes": size}


def _dispatch(adapter, request):
    op = request.get("op")
    if op == "status":
        return adapter.status(request.get("device"))
    if op == "statuses":
        return adapter.statuses()
    if op == "health":
        return adapter.health()
    if op == "exec":
        return adapter.execute(
            request.get("device"),
            request.get("script") or "",
            run_as=request.get("run_as"),
            timeout=int(request.get("timeout") or 180),
            privileged=bool(request.get("privileged")),
            session_timeout=int(request.get("session_timeout") or 30),
        )
    if op == "download":
        return adapter.download(
            request.get("device"),
            request.get("path") or "",
            request.get("destination") or "",
            timeout=int(request.get("timeout") or 600),
        )
    if op == "identity":
        device = identity.resolve(request.get("device"))
        if not device:
            raise TransportError("unknown-device", str(request.get("device")))
        return device
    raise TransportError("bad-request", "unknown op %r" % (op,))


class Handler(socketserver.StreamRequestHandler):
    adapter = None

    def handle(self):
        line = self.rfile.readline()
        if not line:
            return
        try:
            request = json.loads(line)
        except ValueError:
            self._write({"ok": False, "reason": "bad-json", "error": "unparseable request"})
            return
        try:
            result = _dispatch(self.adapter, request)
            self._write({"ok": True, "result": result})
        except TransportError as exc:
            log.warning("request rejected: %s (%s) device=%s op=%s", exc.reason, exc.detail, request.get("device"), request.get("op"))
            self._write({"ok": False, "reason": exc.reason, "error": exc.detail})
        except Exception as exc:  # pragma: no cover
            log.warning("request failed: %s", type(exc).__name__, exc_info=True)
            self._write({"ok": False, "reason": "internal", "error": type(exc).__name__})

    def _write(self, payload):
        try:
            self.wfile.write((json.dumps(payload) + "\n").encode())
            self.wfile.flush()
        except OSError:
            pass


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True
    # Minute-boundary bursts open many short status/exec connections; the
    # default backlog of 5 can refuse them before the threading server accepts.
    request_queue_size = 64


def serve():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    try:
        os.chmod(STATE_DIR, 0o700)
    except OSError:
        pass
    settings = load_settings()
    if not settings.get("SHELLFLEET_USER") or not settings.get("SHELLFLEET_PASSWORD"):
        raise SystemExit("adapter config missing credentials")
    adapter = Adapter(settings)
    adapter.start()
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    Handler.adapter = adapter
    server = Server(SOCKET_PATH, Handler)
    os.chmod(SOCKET_PATH, 0o660)
    log.info("adapter listening on %s (rollout=%s)", SOCKET_PATH, ",".join(adapter.rollout))
    try:
        server.serve_forever()
    finally:
        server.server_close()
        try:
            os.unlink(SOCKET_PATH)
        except OSError:
            pass