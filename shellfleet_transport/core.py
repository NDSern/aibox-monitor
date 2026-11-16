"""Hub connection, framed command execution, and sandboxed file transfer."""

import base64
import gzip
import json
import logging
import os
import ctypes
import gc
import queue
import re
import secrets
import threading
import time
import urllib.parse

import requests

log = logging.getLogger("shellfleet.core")

# Fields retained from each pushed agent record.
_AGENT_FIELDS = ("agent_id", "online", "hostname", "alias", "group")

HUB_DEFAULT = "https://aiboxmng.vnstech.cloud"

# Slow fleet devices can take several seconds to produce the first download
# chunk; the short idle gap below only applies once data is already flowing.
FIRST_CHUNK_WAIT = 15.0


class TransportError(Exception):
    """Raised when the hub/agent path cannot deliver a trustworthy result."""

    def __init__(self, reason, detail=""):
        super().__init__(detail or reason)
        self.reason = reason
        self.detail = detail


ANSI_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][A-Z0-9]")
# Interactive prompts can appear several times on one line, so they are removed
# inline rather than by whole-line matching.
PROMPT_RE = re.compile(r"[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s#$]*[#$]\s?")


def _denoise(text):
    """Remove terminal escape noise and shell prompts but keep line structure."""
    return PROMPT_RE.sub("", ANSI_RE.sub("", text.replace("\r", "")).replace("\x07", ""))

def _clean(text):
    """Drop ANSI sequences and interactive-shell prompts from PTY output."""
    text = ANSI_RE.sub("", text.replace("\r", ""))
    text = text.replace("\x07", "")
    text = PROMPT_RE.sub("", text)
    return "\n".join(line.rstrip() for line in text.split("\n"))


class HubConnection:
    """One authenticated Engine.IO/Socket.IO session for the whole adapter."""

    def __init__(self, username, password, hub=HUB_DEFAULT, poll_timeout=40,
                 request_timeout=20, inventory_ttl=60.0):
        self.hub = hub.rstrip("/")
        self.username = username
        self._password = password
        self.poll_timeout = poll_timeout
        self.request_timeout = request_timeout
        self.inventory_ttl = inventory_ttl
        self.session = None
        self.sid = None
        self.token = None
        # Only events a waiter may still need are retained (see _enqueue).
        self.events = queue.Queue(maxsize=64)
        # Per-request queues keyed by `session_id` or `req_id`. Without this,
        # two concurrent callers steal each other's events out of one queue.
        self._channels = {}
        self._channel_lock = threading.Lock()
        self._stop = threading.Event()
        self._reader = None
        self._lock = threading.RLock()
        self._agents = {}
        self._agents_at = 0.0
        self._connected = False
        self._connected_at = 0.0
        self._last_error = None
        self._sessions = set()
        self._last_trim = time.time()
        self._had_outage = False

    # -- lifecycle ---------------------------------------------------
    def start(self):
        self._connect()
        self._reader = threading.Thread(target=self._read_loop, name="sf-poll", daemon=True)
        self._reader.start()
        threading.Thread(target=self._supervise, name="sf-supervise", daemon=True).start()

    def stop(self):
        self._stop.set()
        self._disconnect()

    _TRIM_INTERVAL = 1800.0

    def _trim_memory(self):
        """Return freed arena pages to the OS; long-lived Python daemons otherwise
        keep fragmentation from transient JSON payloads forever."""
        gc.collect()
        try:
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except Exception:
            pass

    def _supervise(self):
        while not self._stop.wait(5.0):
            if time.time() - self._last_trim >= self._TRIM_INTERVAL:
                self._last_trim = time.time()
                self._trim_memory()
            if self._connected and (time.time() - self._agents_at) > self.inventory_ttl:
                log.warning("inventory stale for %.0fs, reconnecting", time.time() - self._agents_at)
                self._reconnect()
            elif not self._connected:
                self._reconnect()

    def _reconnect(self):
        with self._lock:
            # _read_loop clears _connected before this runs, so a check on that
            # field could never be true and every recovery went unlogged. Track
            # the outage separately instead.
            recovered = self._had_outage
            self._disconnect()
            try:
                self._connect()
                self._had_outage = False
                if recovered:
                    log.info("hub connection restored")
            except Exception as exc:  # pragma: no cover - network path
                self._connected = False
                self._last_error = type(exc).__name__
                log.warning("reconnect failed: %s", type(exc).__name__)

    # -- engine.io ---------------------------------------------------
    def _url(self, **extra):
        params = {"EIO": "4", "transport": "polling", "t": secrets.token_hex(4)}
        params.update(extra)
        return self.hub + "/socket.io/?" + urllib.parse.urlencode(params)

    def _post(self, body):
        # A long-poll response can close the pooled connection between packets,
        # and a reused-but-dead socket surfaces as EOFError/ConnectionError.
        for attempt in (1, 2):
            try:
                response = self.session.post(
                    self._url(sid=self.sid),
                    data=body.encode(),
                    headers={"Content-Type": "text/plain;charset=UTF-8"},
                    timeout=self.request_timeout,
                )
                response.raise_for_status()
                return response.text
            except (requests.ConnectionError, EOFError) as exc:
                if attempt == 2:
                    raise
                log.debug("retrying POST after %s", type(exc).__name__)
                try:
                    self.session.close()
                except Exception:
                    pass

    @staticmethod
    def _decode_packets(text):
        for part in text.split("\x1e"):
            part = part.strip()
            if part.startswith("42/web,"):
                try:
                    packet = json.loads(part[len("42/web,"):])
                except json.JSONDecodeError:
                    continue
                if isinstance(packet, list) and len(packet) == 2:
                    yield packet[0], packet[1]

    def _connect(self):
        session = requests.Session()
        session.headers.update({"User-Agent": "aibox-shellfleet/1.0"})
        response = session.get(self._url(), timeout=self.request_timeout)
        match = re.search(r"0(\{.*\})", response.text)
        if not match:
            raise TransportError("hub-unavailable", "handshake payload missing")
        self.session = session
        self.sid = json.loads(match.group(1))["sid"]
        self._post("40/web")
        self._post("42/web," + json.dumps(["login", {
            "username": self.username, "password": self._password,
        }]))
        deadline = time.time() + 30
        while time.time() < deadline:
            self._drain_once()
            while True:
                try:
                    name, payload = self.events.get_nowait()
                except queue.Empty:
                    break
                if name == "login-result":
                    if not payload.get("ok"):
                        raise TransportError("hub-unavailable", "login rejected")
                    self.token = payload.get("token")
                    self._connected = True
                    self._connected_at = time.time()
                    self._last_error = None
                    return
                self._enqueue(name, payload)
        raise TransportError("hub-unavailable", "login timed out")

    def _disconnect(self):
        try:
            if self.session is not None:
                self._post("41/web")
        except Exception:
            pass
        try:
            if self.session is not None:
                self.session.close()
        except Exception:
            pass
        self.session = None
        self.sid = None
        self._connected = False

    def _drain_once(self):
        response = self.session.get(self._url(sid=self.sid), timeout=self.poll_timeout)
        response.raise_for_status()
        text = response.text.strip()
        if text == "2":
            self._post("3")
            return
        for name, payload in self._decode_packets(text):
            if name == "agent-list" and isinstance(payload, list):
                # Keep only what availability and identity need. The full record
                # carries metrics that change every push; retaining them churns
                # memory for no benefit.
                self._agents = {
                    a.get("agent_id"): {k: a.get(k) for k in _AGENT_FIELDS}
                    for a in payload
                    if isinstance(a, dict) and a.get("agent_id")
                }
                self._agents_at = time.time()
            self._route(name, payload)

    # -- event routing -----------------------------------------------
    def _register(self, key):
        channel = queue.Queue()
        with self._channel_lock:
            self._channels[key] = channel
        return channel

    def _release(self, key):
        with self._channel_lock:
            self._channels.pop(key, None)

    # Events a waiter can be blocked on before its request channel exists.
    _UNSCOPED_EVENTS = ("login-result", "session-started")

    def _enqueue(self, name, payload):
        """Queue only events that an outstanding waiter can still consume.

        The hub pushes `agent-list` (26 agents plus metrics) every ~10 s.
        _drain_once already stores that snapshot; copying it here as well made
        the queue grow ~66 MB/h because nothing drains it in steady state.
        """
        if name not in self._UNSCOPED_EVENTS:
            return
        # put_nowait keeps the check and the insert in one lock; the previous
        # full()-then-put() pair could block or overrun under concurrent callers.
        try:
            self.events.put_nowait((name, payload))
            return
        except queue.Full:
            pass
        try:
            self.events.get_nowait()
        except queue.Empty:
            pass
        try:
            self.events.put_nowait((name, payload))
        except queue.Full:
            pass

    def _route(self, name, payload):
        """Deliver a request-scoped event to its own waiter."""
        key = None
        if isinstance(payload, dict):
            key = payload.get("session_id") or payload.get("req_id")
        if key:
            with self._channel_lock:
                channel = self._channels.get(key)
            if channel is not None:
                channel.put((name, payload))
                return
        self._enqueue(name, payload)

    def _read_loop(self):
        backoff = 1.0
        while not self._stop.is_set():
            try:
                self._drain_once()
                backoff = 1.0
            except Exception as exc:
                if self._stop.is_set():
                    return
                self._last_error = type(exc).__name__
                was_connected = self._connected
                self._connected = False
                # One line per outage, not per retry: availability gaps must be
                # explainable from the journal afterwards.
                self._had_outage = True
                if was_connected:
                    log.warning(
                        "hub poll failed (%s: %s); inventory now unavailable",
                        type(exc).__name__,
                        str(exc)[:160],
                    )
                time.sleep(min(backoff, 10.0))
                backoff = min(backoff * 2, 10.0)

    # -- inventory ---------------------------------------------------
    def agents(self):
        """Return (agents, observed_at, connected). Never invents freshness."""
        return dict(self._agents), self._agents_at, self._connected

    def emit(self, event, payload):
        if not self.session or not self._connected:
            raise TransportError("hub-unavailable", "not connected")
        self._post("42/web," + json.dumps([event, payload]))

    def wait_event(self, names, timeout, predicate=None):
        if isinstance(names, str):
            names = (names,)
        deadline = time.time() + timeout
        skipped = []
        try:
            while time.time() < deadline:
                try:
                    name, payload = self.events.get(timeout=max(0.05, deadline - time.time()))
                except queue.Empty:
                    break
                if name in names and (predicate is None or predicate(payload)):
                    return name, payload
                skipped.append((name, payload))
        finally:
            for name, payload in skipped:
                self._enqueue(name, payload)
        return None, None

    # -- command execution -------------------------------------------
    def execute(self, agent_id, script, run_as=None, timeout=180, session_timeout=30,
                privileged=False):
        """Run a shell script on an agent without PTY echo contaminating output.

        The script is base64-encoded on the way in, so nothing the terminal
        echoes can be mistaken for the result. Markers are generated remotely.
        """
        tag = "sf" + secrets.token_hex(5)
        remote = "/tmp/%s.sh" % tag
        errfile = "/tmp/%s.err" % tag
        path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

        delimiter = "SF_BODY_%s" % tag
        while delimiter in script:
            delimiter += "X"

        if privileged:
            runner = "sudo -n env -i HOME=/root PATH=%s bash -s 2>%s" % (path, errfile)
        elif run_as:
            # Resolve the account's HOME so `~` matches the paths the old SSH
            # transport used; the agent PTY may already be that user.
            runner = (
                'SF_HOME=$(getent passwd %s | cut -d: -f6); '
                'if [ -z "$SF_HOME" ]; then echo NO_SUCH_USER >&2; false; '
                'elif [ "$(id -un)" = %s ]; then env -i HOME="$SF_HOME" PATH=%s bash -s 2>%s; '
                'else sudo -n -u %s env -i HOME="$SF_HOME" PATH=%s bash -s 2>%s; fi'
                % (run_as, run_as, path, errfile, run_as, path, errfile)
            )
        else:
            runner = "bash -s 2>%s" % errfile

        # Everything runs from one file. sudo is configured with use_pty here,
        # and it flushes pending terminal input when it starts, which silently
        # discarded any command lines still queued behind it.
        runner_script = "\n".join([
            "cd /",
            "R=$RANDOM$RANDOM",
            'printf "__SFB_%s__\\n" "$R"',
            "%s <<'%s'" % (runner, delimiter),
            script.rstrip("\n"),
            delimiter,
            "RC=$?",
            'printf "\\n__SFE_%s__%s__\\n" "$R" "$RC"',
            '{ printf "__SFX_%%s__" "$R"; base64 %s 2>/dev/null '
            "| tr -d '\\n\\r' | head -c 65536; printf \"__\\n\"; }" % errfile,
            "rm -f %s %s" % (remote, errfile),
            "",
        ])

        encoded = base64.b64encode(runner_script.encode()).decode()
        chunks = [encoded[i:i + 700] for i in range(0, len(encoded), 700)]
        lines = ["stty -echo 2>/dev/null || true", ": > %s" % remote]
        for chunk in chunks:
            lines.append("printf '%%s' '%s' >> %s" % (chunk, remote))
        lines.append("base64 -d %s > %s.py && mv %s.py %s" % (remote, remote, remote, remote))
        lines += [
            "stty -echo 2>/dev/null || true",
            "bash %s" % remote,
            "stty echo 2>/dev/null || true",
        ]


        payload = "\n".join(lines) + "\n"

        self.emit("start-session", {"agent_id": agent_id})
        # Another caller's acknowledgement must never open this session channel.
        _, ack = self.wait_event(
            "session-started",
            session_timeout,
            lambda event: isinstance(event, dict)
            and (event.get("agent_id") in (None, agent_id)),
        )
        if not ack or not ack.get("session_id"):
            raise TransportError("agent-unreachable", "no session")
        session_id = ack["session_id"]
        self._sessions.add(session_id)
        channel = self._register(session_id)
        buffer = []
        body_start = None
        try:
            self.emit("pty-input", {"session_id": session_id, "input": payload})
            deadline = time.time() + timeout
            while time.time() < deadline:
                try:
                    name, event = channel.get(timeout=max(0.05, deadline - time.time()))
                except queue.Empty:
                    break
                if name != "pty-output" or not isinstance(event, dict):
                    continue
                if event.get("session_id") != session_id:
                    continue
                buffer.append(event.get("output") or "")
                joined = _denoise("".join(buffer))
                if body_start is None:
                    marker = re.search(r"__SFB_(\d+)__", joined)
                    if marker:
                        body_start = marker.group(1)
                        buffer = [joined[marker.end():]]
                        joined = buffer[0]
                    else:
                        continue
                end = re.search(r"__SFE_%s__(\d+)__" % body_start, joined)
                if end:
                    # The stderr section is printed by a separate command and can
                    # arrive in a later packet, so wait briefly for its terminator.
                    grace = time.time() + 3.0
                    err = re.search(r"__SFX_%s__([A-Za-z0-9+/=\\s]*)__" % body_start, joined)
                    while not err and time.time() < grace:
                        try:
                            name, event = channel.get(timeout=max(0.05, grace - time.time()))
                        except queue.Empty:
                            break
                        if name != "pty-output" or not isinstance(event, dict):
                            continue
                        if event.get("session_id") != session_id:
                            continue
                        buffer.append(event.get("output") or "")
                        joined = _denoise("".join(buffer))
                        err = re.search(r"__SFX_%s__([A-Za-z0-9+/=\\s]*)__" % body_start, joined)
                    stdout = joined[:end.start()]
                    stderr = ""
                    if err and err.group(1):
                        try:
                            stderr = base64.b64decode(err.group(1)).decode("utf-8", "replace")
                        except Exception:
                            stderr = ""
                    result = {
                        "exit_code": int(end.group(1)),
                        "stdout": _clean(stdout),
                        "stderr": stderr,
                    }
                    if os.environ.get("SHELLFLEET_DEBUG") and not stderr:
                        result["debug_tail"] = joined[-600:]
                    return result
            raise TransportError("command-timeout", "no completion marker")
        finally:
            self._sessions.discard(session_id)
            self._release(session_id)
            try:
                self.emit("close-session", {"session_id": session_id})
            except Exception:
                pass

    # -- file transfer -----------------------------------------------
    def download(self, agent_id, sandbox_path, destination, timeout=600,
                 max_bytes=64 * 1024 * 1024):
        """Download one sandboxed file.

        The hub streams base64 chunks and reports `total` as the chunk count.
        Chunks are gzipped by the agent; verify ordering, then decompress.
        """
        request_id = "d" + secrets.token_hex(6)
        channel = self._register(request_id)
        try:
            self.emit("fs-download", {
                "agent_id": agent_id, "req_id": request_id, "path": sandbox_path,
            })
            chunks = {}
            total_chunks = None
            last_seq = -1
            start = time.time()
            deadline = start + timeout
            while time.time() < deadline:
                # Bound the wait for the FIRST chunk; stray events must not keep
                # a dead transfer alive past this patience window.
                if not chunks and time.time() - start > FIRST_CHUNK_WAIT:
                    break
                idle = 1.0 if chunks else FIRST_CHUNK_WAIT
                try:
                    # The hub reports `total`, but on larger files it does not
                    # match the number of chunks actually sent, so stop on an
                    # idle gap rather than trusting it. One second covers the
                    # observed ship round trip without stalling every file.
                    name, event = channel.get(timeout=min(idle, max(0.05, deadline - time.time())))
                except queue.Empty:
                    break
                if name != "fs-event" or not isinstance(event, dict):
                    continue
                if event.get("req_id") != request_id:
                    continue
                kind = event.get("kind")
                if kind == "error":
                    raise TransportError("transfer-failed", str(event.get("error") or "error"))
                if kind != "chunk":
                    continue
                if isinstance(event.get("total"), int):
                    total_chunks = event["total"]
                seq = event.get("seq")
                if isinstance(seq, int) and isinstance(event.get("data"), str):
                    chunks[seq] = event["data"]
                    last_seq = max(last_seq, seq)
        finally:
            self._release(request_id)
        if not chunks:
            raise TransportError("transfer-failed", "no chunks")
        if sorted(chunks) != list(range(len(chunks))):
            raise TransportError("transfer-failed", "chunk sequence gap")
        raw = base64.b64decode("".join(chunks[key] for key in sorted(chunks)))
        if raw[:2] == b"\x1f\x8b":
            try:
                data = gzip.decompress(raw)
            except EOFError as exc:
                # A truncated gzip stream means the hub stopped early; never
                # hand a partial file to the caller.
                raise TransportError(
                    "transfer-incomplete",
                    "chunks=%d last_seq=%d raw=%d: %s" % (len(chunks), last_seq, len(raw), exc),
                )
        else:
            data = raw
        if len(data) > max_bytes:
            raise TransportError("transfer-failed", "payload too large")
        tmp = destination + ".part"
        with open(tmp, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, destination)
        return len(data)

    # -- diagnostics -------------------------------------------------
    def snapshot_age(self):
        return None if not self._agents_at else time.time() - self._agents_at