import logging
from logging.handlers import RotatingFileHandler
import json
import signal
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import config
import aibox_transport as transport

logging.basicConfig(
    level=getattr(logging, config.LOG_LEVEL),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        RotatingFileHandler(config.LOG_FILE, maxBytes=16 * 1024 * 1024, backupCount=8, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)

logger = logging.getLogger(__name__)

SSH_OPTIONS = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ControlMaster=auto",
    "-o", "ControlPath=/tmp/aibox-monitor-ssh-%C",
    "-o", "ControlPersist=5m",
]

CAMERA_IMAGE_OWNERS = {
    "th06-lan": {f"192.168.0.{n}": "100.64.0.82" for n in range(65, 69)},
    "th08-lan": {"192.168.0.66": "100.64.0.122", "192.168.0.67": "100.64.0.122",
                 "192.168.0.68": "100.64.0.122", "192.168.0.105": "100.64.0.122"},
    "giaminh-lan": {
        "192.168.1.4": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.8": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.11": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.20": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.109": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.110": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.111": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.112": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.113": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.114": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.115": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.116": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.117": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.118": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.122": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.123": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.124": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.125": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.126": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.127": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.129": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.152": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.153": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.154": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.155": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.156": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.157": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.158": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.159": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.160": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.161": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.162": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.163": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.164": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.166": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.167": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.168": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.169": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.170": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.171": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.172": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.173": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.174": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.175": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.176": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.177": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.179": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.181": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.182": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.183": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.185": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.186": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.187": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.203": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.209": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.211": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
        "192.168.1.218": ("100.64.0.49", "100.64.0.96", "100.64.0.97"),
    },
    "td08-lan": {f"192.168.0.{n}": "100.64.0.27" for n in range(65, 68)},
    "td09-lan": {f"192.168.0.{n}": "100.64.0.121" for n in range(65, 68)},
    "th04-lan": {f"192.168.0.{n}": "100.64.0.1" for n in range(65, 69)},
    "th07-lan": {f"192.168.0.{n}": "100.64.0.104" for n in range(65, 69)},
    "th09-lan": {f"192.168.0.{n}": "100.64.0.123" for n in range(65, 69)},
    "myxuan-lan": {f"192.168.2.{n}": ("100.64.0.116", "100.64.0.36", "100.64.0.65") for n in range(50, 61)},
    "starcity-lan": {f"192.168.0.{n}": "100.64.0.44" for n in range(65, 71)},
    "oceanus-lan": {f"192.168.0.{n}": "100.64.0.80" for n in (65, 66, 67, 68, 69, 70)},
    "neptune-lan": {f"192.168.1.{n}": "100.64.0.85" for n in (65, 66, 67, 68, 69, 71, 72, 73, 74)},
    "th05-lan": {f"192.168.0.{n}": "100.64.0.81" for n in range(65, 69)},
}
CAMERA_PROBE_ONLINE_MINIMUM = 5
CAMERA_PROBE_WORKERS = 6


class AiboxMonitor:
    def __init__(self):
        self.aibox_status = {}
        self.target_status = {}
        self.target_last_known_status = {}
        self.unknown_target_status = set()
        self.unknown_target_reason: dict[str, str | None] = {}
        self.resource_status = {}
        self.running = False

    @staticmethod
    def _ping_host(ip_address: str) -> bool:
        try:
            result = subprocess.run(
                ["ping", "-c", "1", "-W", str(config.PING_TIMEOUT_SECONDS), ip_address],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=config.PING_TIMEOUT_SECONDS + 3,
            )
            return result.returncode == 0
        except (subprocess.TimeoutExpired, OSError) as e:
            logger.warning(f"Failed to ping AIBOX {ip_address}: {e}")
            return False










    @staticmethod
    def _aibox_state(ip_address: str) -> str:
        """Online/offline/unknown; Shell Fleet owns migrated devices."""
        if transport.migrated(ip_address):
            return transport.state(ip_address)
        return "online" if AiboxMonitor._ping_host(ip_address) else "offline"

    @staticmethod
    def _remote(user: str, aibox_ip: str, argv: list[str], timeout: int,
                stdin_text: str | None = None):
        """Run one command on the AIBOX through whichever transport owns it."""
        if transport.migrated(aibox_ip):
            return transport.run(user, aibox_ip, argv, timeout, stdin_text=stdin_text)
        return subprocess.run(
            ["ssh", *SSH_OPTIONS, f"{user}@{aibox_ip}", *argv],
            input=stdin_text,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

    @staticmethod
    def _target_key(aibox_ip: str, target_ip: str) -> str:
        return f"{aibox_ip}:{target_ip}"

    def _select_target_checker(self, aibox: dict, target_ip: str | None = None) -> dict | None:
        self._selector_lan_skips = 0
        checkers = aibox.get("checkers") or [{
            "name": aibox["name"],
            "user": aibox["user"],
            "ip": aibox["ip"],
            "target-interface": aibox.get("target-interface"),
        }]
        for checker in checkers:
            checker_ip = checker["ip"]
            checker_user = checker["user"]
            checker_state = self.aibox_status.get(checker_ip) or "unknown"
            if checker_state != "online":
                logger.warning(
                    f"Skipping target checker because AIBOX is {checker_state}: "
                    f"{checker.get('name', checker_ip)} ({checker_ip})"
                )
                continue
            if not self._can_ssh(checker_user, checker_ip):
                logger.warning(f"Skipping target checker because SSH is unavailable: {checker_user}@{checker_ip}")
                continue
            target_interface = checker.get("target-interface")
            if target_interface and (target_ip or aibox.get("targets")):
                route_target = target_ip or next(iter(aibox["targets"]))
                route_interface = self._target_route_interface(checker_user, checker_ip, route_target)
                if route_interface != target_interface:
                    self._selector_lan_skips += 1
                    logger.warning(
                        f"Skipping target checker because target LAN is unavailable: {aibox['name']} via "
                        f"{checker.get('name', checker_ip)} ({checker_ip}); target {route_target} expected interface "
                        f"{target_interface}, got {route_interface or 'none'}"
                    )
                    continue
            return checker
        return None

    @staticmethod
    def _target_status_key(aibox: dict) -> str:
        return aibox.get("id") or aibox["ip"]

    @staticmethod
    def _can_ssh(user: str, aibox_ip: str) -> bool:
        if not user or not aibox_ip:
            return False
        if transport.migrated(aibox_ip):
            # Transport readiness, not SSH: the adapter owns this device.
            return transport.state(aibox_ip) == "online"

        try:
            result = subprocess.run(
                [
                    "ssh",
                    *SSH_OPTIONS,
                    f"{user}@{aibox_ip}",
                    "true",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
            return result.returncode == 0
        except (subprocess.TimeoutExpired, OSError) as e:
            logger.warning(f"Failed SSH login check for {user}@{aibox_ip}: {e}")
            return False

    @staticmethod
    def _target_route_interface(user: str, aibox_ip: str, target_ip: str) -> str | None:
        try:
            result = AiboxMonitor._remote(
                user, aibox_ip, ["ip", "-json", "route", "get", target_ip], 10
            )
            if result.returncode != 0:
                return None
            routes = json.loads(result.stdout)
            if not isinstance(routes, list) or not routes:
                return None
            interface = routes[0].get("dev")
            return interface if isinstance(interface, str) and interface else None
        except (json.JSONDecodeError, subprocess.TimeoutExpired, OSError) as e:
            logger.warning(f"Failed target route check for {target_ip} from AIBOX {aibox_ip}: {e}")
            return None

    @staticmethod
    def _ping_target_from_aibox(user: str, aibox_ip: str, target_ip: str) -> bool:
        try:
            result = AiboxMonitor._remote(
                user,
                aibox_ip,
                ["ping", "-c", "1", "-W", str(config.PING_TIMEOUT_SECONDS), target_ip],
                config.PING_TIMEOUT_SECONDS + 8,
            )
            return result.returncode == 0
        except (subprocess.TimeoutExpired, OSError) as e:
            logger.warning(f"Failed to ping target {target_ip} from AIBOX {aibox_ip}: {e}")
            return False

    @staticmethod
    def _probe_camera_from_aibox(user: str, aibox_ip: str, target_ip: str) -> dict | None:
        try:
            result = AiboxMonitor._remote(
                user,
                aibox_ip,
                ["python3", "/usr/local/bin/aibox-camera-probe", "probe", target_ip],
                90,
            )
            if result.returncode != 0:
                return {"status": "fallback", "method": "probe-unavailable"}
            value = json.loads(result.stdout)
            if not isinstance(value, dict):
                return {"status": "fallback", "method": "probe-unavailable"}
            if (value.get("status") in ("online", "offline") and value.get("method") == "image"
                    and isinstance(value.get("frames"), int) and 0 <= value["frames"] <= 10
                    and isinstance(value.get("valid_frames"), int) and 0 <= value["valid_frames"] <= value["frames"]
                    and (value["status"] == "online") == (value["valid_frames"] > 0)):
                return value
            if value.get("status") == "fallback":
                return value
            return {"status": "fallback", "method": "probe-unavailable"}
        except (json.JSONDecodeError, subprocess.TimeoutExpired, OSError, AttributeError):
            return {"status": "fallback", "method": "probe-unavailable"}

    @staticmethod
    def _collect_resources_from_aibox(user: str, aibox_ip: str) -> dict[str, float] | None:
        script = r'''
import json
import time

def read_cpu():
    with open('/proc/stat', encoding='utf-8') as f:
        parts = [int(x) for x in f.readline().split()[1:]]
    idle = parts[3] + parts[4]
    total = sum(parts)
    return idle, total

def cpu_percent():
    idle1, total1 = read_cpu()
    time.sleep(1)
    idle2, total2 = read_cpu()
    total_delta = total2 - total1
    idle_delta = idle2 - idle1
    if total_delta <= 0:
        return 0.0
    return max(0.0, min(100.0, (1 - idle_delta / total_delta) * 100))

def ram_percent():
    values = {}
    with open('/proc/meminfo', encoding='utf-8') as f:
        for line in f:
            key, value = line.split(':', 1)
            values[key] = int(value.strip().split()[0])
    total = values.get('MemTotal', 0)
    available = values.get('MemAvailable', 0)
    if total <= 0:
        return 0.0
    return max(0.0, min(100.0, (total - available) / total * 100))

def npu_percent(path):
    try:
        with open(path, encoding='utf-8') as f:
            return float(f.read().strip())
    except (OSError, ValueError):
        return 0.0

print(json.dumps({
    'CPU': cpu_percent(),
    'RAM': ram_percent(),
    'NPU Core 0': npu_percent('/sys/class/misc/rknpu/load0'),
    'NPU Core 1': npu_percent('/sys/class/misc/rknpu/load1'),
    'NPU Core 2': npu_percent('/sys/class/misc/rknpu/load2'),
}))
'''
        try:
            result = AiboxMonitor._remote(
                user, aibox_ip, ["python3", "-"], 20, stdin_text=script
            )
            if result.returncode != 0:
                logger.warning(f"Failed to collect resources from {user}@{aibox_ip}: {result.stderr.strip()}")
                return None
            data = json.loads(result.stdout)
            return {name: float(value) for name, value in data.items()}
        except (subprocess.TimeoutExpired, OSError, json.JSONDecodeError, ValueError) as e:
            logger.warning(f"Failed resource collection for {user}@{aibox_ip}: {e}")
            return None

    @staticmethod
    def _resource_threshold(resource_name: str) -> int:
        if resource_name == "CPU":
            return config.CPU_THRESHOLD
        if resource_name == "RAM":
            return config.RAM_THRESHOLD
        return config.NPU_THRESHOLD












    def check_aiboxes(self) -> None:
        aibox_configs = config.get_aibox_configs()
        checked_aibox_configs = []
        for aibox in aibox_configs:
            if aibox["check-devices"] and aibox["local"]:
                checked_aibox_configs.append(aibox)
                logger.info(f"Running local AIBOX check: {aibox['name']} ({len(aibox['targets'])} targets)")
            elif not aibox["check-devices"]:
                logger.info(f"Skipping disabled AIBOX check: {aibox['name']} ({aibox.get('ip', '')})")
        if not checked_aibox_configs:
            logger.info("No local AIBOX checks configured")

        logger.info("Checking AIBOX connectivity...")
        for aibox in checked_aibox_configs:
            for ip_address, name in aibox["targets"].items():
                state = self._aibox_state(ip_address)
                was_online = self.aibox_status.get(ip_address)

                if was_online is None:
                    logger.info(f"Initial AIBOX state: {name} ({ip_address}) is {state}")
                elif was_online == "online" and state != "online":
                    logger.warning(f"AIBOX offline: {name} ({ip_address}) is {state}")
                elif was_online != "online" and state == "online":
                    logger.info(f"AIBOX back online: {name} ({ip_address})")
                else:
                    logger.info(f"AIBOX unchanged: {name} ({ip_address}) is {state}")

                self.aibox_status[ip_address] = state

    def check_aibox_targets(self) -> None:
        logger.info("Checking devices behind AIBOXes...")
        for aibox in config.get_aibox_configs():
            if not aibox["check-devices"]:
                logger.info(f"Skipping disabled target checks: {aibox['name']} ({aibox.get('ip', '')})")
                continue
            if aibox["local"]:
                logger.info(f"Skipping local target checks: {aibox['name']}")
                continue
            status_key = self._target_status_key(aibox)
            checked_targets = 0
            lan_down_targets: set[str] = set()
            candidate_lan: dict[str, bool] = {}
            default_checker_lan = False
            available_checkers = {}
            default_checker_loaded = False
            default_checker = None
            default_checked_targets = []
            logger.info(f"Target checks started from {aibox['name']}: {len(aibox['targets'])} target(s)")
            plans = []
            for target_ip, target_name in aibox["targets"].items():
                owners = CAMERA_IMAGE_OWNERS.get(aibox.get("id"), {}).get(target_ip)
                owner_ips = (owners,) if isinstance(owners, str) else tuple(owners or ())
                owner_ip = owner_ips[0] if owner_ips else None
                checker = None
                for candidate_ip in owner_ips:
                    checker_config = next((item for item in aibox.get("checkers", []) if item["ip"] == candidate_ip), None)
                    if not checker_config:
                        continue
                    if candidate_ip not in available_checkers:
                        selected = self._select_target_checker({**aibox, "checkers": [checker_config]}, target_ip)
                        available_checkers[candidate_ip] = selected or False
                        candidate_lan[candidate_ip] = self._selector_lan_skips > 0
                    if available_checkers[candidate_ip]:
                        checker = available_checkers[candidate_ip]
                        break
                if owner_ip:
                    if checker is None:
                        lan_down = any(candidate_lan.get(ip) for ip in owner_ips)
                        if lan_down:
                            lan_down_targets.add(target_ip)
                        self._record_target_unknown(status_key, aibox, target_name, target_ip, reason="lan-down" if lan_down else None)
                        continue
                if checker is None and not owner_ip:
                    if not default_checker_loaded:
                        default_checker = self._select_target_checker(aibox, target_ip)
                        default_checker_loaded = True
                        default_checker_lan = self._selector_lan_skips > 0
                        if default_checker:
                            available_checkers[default_checker["ip"]] = default_checker
                    checker = default_checker
                if checker is None:
                    if default_checker_lan:
                        lan_down_targets.add(target_ip)
                    self._record_target_unknown(status_key, aibox, target_name, target_ip, reason="lan-down" if default_checker_lan else None)
                    continue

                aibox_ip, user = checker["ip"], checker["user"]
                if not owner_ip:
                    default_checked_targets.append(target_ip)
                plans.append({"target_ip": target_ip, "target_name": target_name, "checker": checker, "owner": owner_ip})

            def run_plan(plan):
                checker = plan["checker"]
                probe = (self._probe_camera_from_aibox(checker["user"], checker["ip"], plan["target_ip"])
                         if plan["owner"] else None)
                if probe and probe.get("status") in ("online", "offline"):
                    return plan, probe["status"] == "online", "image", probe.get("valid_frames"), probe.get("frames")
                is_online = self._ping_target_from_aibox(checker["user"], checker["ip"], plan["target_ip"])
                return plan, is_online, "ping-fallback" if plan["owner"] else "ping", None, None

            results = []
            if plans:
                with ThreadPoolExecutor(max_workers=CAMERA_PROBE_WORKERS) as pool:
                    results = list(pool.map(run_plan, plans))
            checked_targets = len(results)
            for plan, is_online, method, valid_frames, frames_total in results:
                target_ip = plan["target_ip"]
                target_name = plan["target_name"]
                quality_tag = ""
                if valid_frames is not None and frames_total:
                    quality_tag = f"[valid={valid_frames}/{frames_total}]"
                key = self._target_key(status_key, target_ip)
                was_online = self.target_last_known_status.get(key, self.target_status.get(key))
                state = "online" if is_online else "offline"

                if was_online is None:
                    logger.info(f"Initial target state from {aibox['name']}: {target_name} ({target_ip}) is {state} [method={method}]{quality_tag}")
                elif was_online and not is_online:
                    logger.warning(f"Target offline from {aibox['name']}: {target_name} ({target_ip}) [method={method}]{quality_tag}")
                elif not was_online and is_online:
                    logger.info(f"Target back online from {aibox['name']}: {target_name} ({target_ip}) [method={method}]{quality_tag}")
                else:
                    logger.info(f"Target unchanged from {aibox['name']}: {target_name} ({target_ip}) is {state} [method={method}]{quality_tag}")

                self.target_status[key] = is_online
                self.target_last_known_status[key] = is_online
                self.unknown_target_status.discard(key)
                self.unknown_target_reason.pop(key, None)
            if checked_targets:
                logger.info(f"Target checks completed from {aibox['name']}: {checked_targets} target(s)")
            elif lan_down_targets:
                # AIBOX is reachable (SSH answered) but its camera LAN route is
                # wrong, so the cameras are unseen, not necessarily powered off.
                logger.warning(f"Target checks unavailable from {aibox['name']}: target LAN unavailable")
            else:
                self._scope_unknown(aibox, "no checker available")
    def _record_target_unknown(self, status_key: str, aibox: dict, target_name: str, target_ip: str, reason: str | None = None) -> None:
        key = self._target_key(status_key, target_ip)
        # Re-log when the reason changes so an already-unknown camera can move
        # from a generic unknown to a specific LAN-down cause without needing
        # an intermediate online state.
        if key not in self.unknown_target_status or self.unknown_target_reason.get(key) != reason:
            method = reason or "unknown"
            logger.info(f"Target state unknown from {aibox['name']}: {target_name} ({target_ip}) [method={method}]")
        self.unknown_target_status.add(key)
        self.unknown_target_reason[key] = reason


    def _scope_unknown(self, aibox: dict, reason: str) -> None:
        status_key = self._target_status_key(aibox)
        for target_ip, target_name in aibox.get("targets", {}).items():
            self._record_target_unknown(status_key, aibox, target_name, target_ip)
        logger.warning(f"Target checks unavailable from {aibox['name']}: {reason}")

    def check_aibox_resources(self) -> None:
        logger.info("Checking AIBOX resource usage...")
        for aibox in config.get_aibox_configs():
            if not aibox["check-resource"]:
                continue
            if aibox["local"]:
                logger.info(f"Skipping local resource checks: {aibox['name']}")
                continue

            aibox_ip = aibox["ip"]
            user = aibox["user"]
            state = self.aibox_status.get(aibox_ip)
            if state is None:
                state = self._aibox_state(aibox_ip)
                self.aibox_status[aibox_ip] = state
            if state != "online":
                logger.warning(
                    f"Skipping resource checks because AIBOX is {state}: "
                    f"{aibox['name']} ({aibox_ip})"
                )
                continue

            resources = self._collect_resources_from_aibox(user, aibox_ip)
            if resources is None:
                continue
            self.resource_status[aibox_ip] = resources

            over_threshold = {
                name: usage
                for name, usage in resources.items()
                if usage >= self._resource_threshold(name)
            }
            if len(over_threshold) > 1:
                logger.warning(f"Resource alert for {aibox['name']}: {over_threshold}")
            else:
                logger.info(f"Resource usage normal for {aibox['name']}: {resources}")


    def run(self) -> None:
        self.running = True
        logger.info("=" * 50)
        logger.info("AIBOX Monitor Started")
        logger.info(f"Ping interval: {config.PING_INTERVAL_SECONDS}s")
        logger.info("=" * 50)

        while self.running:
            self.check_aiboxes()
            self.check_aibox_targets()
            self.check_aibox_resources()
            logger.info(f"Sleeping for {config.PING_INTERVAL_SECONDS} seconds...")
            sleep_until = time.monotonic() + config.PING_INTERVAL_SECONDS
            while self.running and time.monotonic() < sleep_until:
                time.sleep(min(1, sleep_until - time.monotonic()))

    def stop(self) -> None:
        self.running = False
        logger.info("AIBOX Monitor stopped.")


monitor = AiboxMonitor()


def signal_handler(sig, frame):
    logger.info("Received shutdown signal...")
    monitor.stop()
    sys.exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    try:
        monitor.run()
    except KeyboardInterrupt:
        monitor.stop()
    except Exception as e:
        logger.exception(f"Fatal error: {e}")
        sys.exit(1)
