import logging
from logging.handlers import RotatingFileHandler
import json
import signal
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from html import escape

import config
from email_alert import EmailAlert

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
    "kimhoa": {
        "192.168.1.123": ("100.64.0.114", "100.64.0.115"), "192.168.1.126": ("100.64.0.114", "100.64.0.115"),
        "192.168.1.124": ("100.64.0.114", "100.64.0.115"), "192.168.1.121": ("100.64.0.114", "100.64.0.115"),
        "192.168.1.122": ("100.64.0.114", "100.64.0.115"), "192.168.1.125": ("100.64.0.114", "100.64.0.115"),
        "192.168.1.127": ("100.64.0.114", "100.64.0.115"),
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
        self.email_alert = EmailAlert()
        self.aibox_status = {}
        self.target_status = {}
        self.target_last_known_status = {}
        self.unknown_target_status = set()
        self.resource_status = {}
        self.last_status_summary_slot = None
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

    def _send_down_email(
        self,
        ip_address: str,
        name: str,
        hostname: str,
        timestamp: str,
        recipients: list[str],
        aiboxes: dict[str, str],
    ) -> None:
        body = config.DOWN_BODY_TEMPLATE.format(
            hostname=hostname,
            timestamp=timestamp,
            ip=ip_address,
            name=name,
            aibox_rows=self._build_aibox_rows(aiboxes, self.aibox_status, {ip_address: "Mất kết nối"}),
        )
        self.email_alert.send_status_email(config.DOWN_SUBJECT, body, recipients)

    def _send_up_email(
        self,
        ip_address: str,
        name: str,
        hostname: str,
        timestamp: str,
        recipients: list[str],
        aiboxes: dict[str, str],
    ) -> None:
        body = config.UP_BODY_TEMPLATE.format(
            hostname=hostname,
            timestamp=timestamp,
            ip=ip_address,
            name=name,
            aibox_rows=self._build_aibox_rows(aiboxes, self.aibox_status, {ip_address: "Đã kết nối lại"}),
        )
        self.email_alert.send_status_email(config.UP_SUBJECT, body, recipients)

    def _send_status_summary_email(
        self,
        timestamp: str,
        recipients: list[str],
        aiboxes: dict[str, str],
    ) -> None:
        body = config.STATUS_SUMMARY_BODY_TEMPLATE.format(
            timestamp=timestamp,
            aibox_rows=self._build_aibox_rows(
                aiboxes, self.aibox_status, {}
            ),
        )
        self.email_alert.send_status_email(config.STATUS_SUMMARY_SUBJECT, body, recipients)

    @staticmethod
    def _status_summary_slot(now: datetime) -> str | None:
        if now.hour not in config.STATUS_SUMMARY_HOURS:
            return None
        return now.strftime("%Y-%m-%d %H")

    @staticmethod
    def _change_email_style(changed_statuses: dict[str, str]) -> tuple[str, str]:
        if changed_statuses and all(status == "Đã kết nối lại" for status in changed_statuses.values()):
            return "KHÔI PHỤC", "#15803d"
        return "CẢNH BÁO", "#b91c1c"

    @staticmethod
    def _group_recipients(aibox_configs: list[dict]) -> dict[tuple[str, ...], list[dict]]:
        groups = {}
        for aibox in aibox_configs:
            key = tuple(aibox["recipients"])
            groups.setdefault(key, []).append(aibox)
        return groups

    @staticmethod
    def _aibox_report_recipients(aibox_configs: list[dict]) -> list[str]:
        for aibox in aibox_configs:
            if aibox["check-devices"] and aibox["local"]:
                return list(aibox["recipients"])
        return config.get_recipient_emails()

    @staticmethod
    def _aibox_report_targets(aibox_configs: list[dict]) -> dict[str, str]:
        return {
            ip_address: name
            for aibox in aibox_configs
            if aibox["check-devices"] and aibox["local"]
            for ip_address, name in aibox["targets"].items()
        }

    @staticmethod
    def _aibox_status_groups(aibox_configs: list[dict]) -> dict[str, dict]:
        fallback_targets = {}
        fallback_recipients = None
        for aibox in aibox_configs:
            if not (aibox["check-devices"] and aibox["local"]):
                continue
            recipient_groups = aibox.get("recipient_groups")
            status_groups = aibox.get("status_recipient_groups")
            has_v2_grouping = "recipient_groups" in aibox or "status_recipient_groups" in aibox
            if has_v2_grouping and (recipient_groups is None or status_groups is None):
                logger.error(f"Skipping AIBOX status emails because status recipient grouping is incomplete: {aibox['name']}")
                return {}
            if recipient_groups is None and status_groups is None:
                if fallback_recipients is None:
                    fallback_recipients = list(aibox["recipients"])
                fallback_targets.update(aibox["targets"])
                continue

            grouped = {}
            for ip_address, name in aibox["targets"].items():
                group_name = status_groups.get(ip_address)
                if group_name is None:
                    logger.error(f"Skipping AIBOX status emails because {ip_address} has no status recipient group")
                    return {}
                if group_name not in recipient_groups:
                    logger.error(f"Skipping AIBOX status emails because group is undefined: {group_name}")
                    return {}
                group = grouped.setdefault(
                    group_name,
                    {
                        "recipients": list(recipient_groups[group_name]),
                        "name": f"Nhóm AIBOX {group_name}",
                        "targets": {},
                    },
                )
                group["targets"][ip_address] = name
            return grouped
        if fallback_targets and fallback_recipients is not None:
            return {
                "aibox_report": {
                    "recipients": fallback_recipients,
                    "name": "Tất cả AIBOX",
                    "targets": fallback_targets,
                }
            }
        return {}

    @staticmethod
    def _target_key(aibox_ip: str, target_ip: str) -> str:
        return f"{aibox_ip}:{target_ip}"

    def _select_target_checker(self, aibox: dict, target_ip: str | None = None) -> dict | None:
        checkers = aibox.get("checkers") or [{
            "name": aibox["name"],
            "user": aibox["user"],
            "ip": aibox["ip"],
            "target-interface": aibox.get("target-interface"),
        }]
        for checker in checkers:
            checker_ip = checker["ip"]
            checker_user = checker["user"]
            if not self.aibox_status.get(checker_ip, False):
                logger.warning(f"Skipping target checker because AIBOX is offline: {checker.get('name', checker_ip)} ({checker_ip})")
                continue
            if not self._can_ssh(checker_user, checker_ip):
                logger.warning(f"Skipping target checker because SSH is unavailable: {checker_user}@{checker_ip}")
                continue
            target_interface = checker.get("target-interface")
            if target_interface and (target_ip or aibox.get("targets")):
                route_target = target_ip or next(iter(aibox["targets"]))
                route_interface = self._target_route_interface(checker_user, checker_ip, route_target)
                if route_interface != target_interface:
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
            result = subprocess.run(
                [
                    "ssh",
                    *SSH_OPTIONS,
                    f"{user}@{aibox_ip}",
                    "ip",
                    "-json",
                    "route",
                    "get",
                    target_ip,
                ],
                capture_output=True,
                text=True,
                timeout=10,
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
            result = subprocess.run(
                [
                    "ssh",
                    *SSH_OPTIONS,
                    f"{user}@{aibox_ip}",
                    "ping",
                    "-c",
                    "1",
                    "-W",
                    str(config.PING_TIMEOUT_SECONDS),
                    target_ip,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=config.PING_TIMEOUT_SECONDS + 8,
            )
            return result.returncode == 0
        except (subprocess.TimeoutExpired, OSError) as e:
            logger.warning(f"Failed to ping target {target_ip} from AIBOX {aibox_ip}: {e}")
            return False

    @staticmethod
    def _probe_camera_from_aibox(user: str, aibox_ip: str, target_ip: str) -> dict | None:
        try:
            result = subprocess.run(
                ["ssh", *SSH_OPTIONS, f"{user}@{aibox_ip}", "python3", "/usr/local/bin/aibox-camera-probe", "probe", target_ip],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=90,
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
            result = subprocess.run(
                [
                    "ssh",
                    *SSH_OPTIONS,
                    f"{user}@{aibox_ip}",
                    "python3",
                    "-",
                ],
                input=script,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=20,
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

    def _build_target_rows(
        self,
        targets: dict[str, str],
        target_status: dict[str, bool],
        changed_statuses: dict[str, str],
        aibox_ip: str,
    ) -> str:
        rows = []
        for target_ip, name in targets.items():
            key = AiboxMonitor._target_key(aibox_ip, target_ip)
            changed_status = changed_statuses.get(target_ip)
            status = changed_status
            is_online = self._current_target_status(key)
            is_unknown = key in self.unknown_target_status
            if is_online is None:
                is_online = self.target_last_known_status.get(key)
            if status is None and is_unknown:
                last_known = "Đang kết nối" if is_online else "Mất kết nối" if is_online is not None else "Chưa ghi nhận"
                status = f"Không xác định (lần cuối: {last_known})"
            elif status is None and is_online is not None:
                status = "Đang kết nối" if is_online else "Mất kết nối"
            if status is None:
                status = "Chưa ghi nhận"

            color = "#15803d" if status in ("Đang kết nối", "Đã kết nối lại") else "#b91c1c" if status == "Mất kết nối" else "#6b7280"
            bg = ""
            if changed_status:
                bg = "background:#ecfdf5;" if changed_status == "Đã kết nối lại" else "background:#fef2f2;"
            rows.append(
                f'<tr style="{bg}">'
                f'<td style="border:1px solid #ddd;padding:8px;color:{color};font-weight:bold;">{escape(status)}</td>'
                f'<td style="border:1px solid #ddd;padding:8px;">{escape(name)}</td>'
                f'<td style="border:1px solid #ddd;padding:8px;">{escape(target_ip)}</td>'
                "</tr>"
            )
        return "\n".join(rows)

    def _send_target_down_email(
        self,
        aibox: dict,
        timestamp: str,
        changed_statuses: dict[str, str],
    ) -> None:
        body = config.TARGET_DOWN_BODY_TEMPLATE.format(
            aibox_name=aibox["name"],
            aibox_ip=aibox["ip"],
            timestamp=timestamp,
            target_rows=self._build_target_rows(aibox["targets"], self.target_status, changed_statuses, self._target_status_key(aibox)),
        )
        self.email_alert.send_status_email(
            config.TARGET_DOWN_SUBJECT.format(aibox_name=aibox["name"]), body, aibox["recipients"]
        )

    def _send_target_up_email(
        self,
        aibox: dict,
        timestamp: str,
        changed_statuses: dict[str, str],
    ) -> None:
        body = config.TARGET_UP_BODY_TEMPLATE.format(
            aibox_name=aibox["name"],
            aibox_ip=aibox["ip"],
            timestamp=timestamp,
            target_rows=self._build_target_rows(aibox["targets"], self.target_status, changed_statuses, self._target_status_key(aibox)),
        )
        self.email_alert.send_status_email(
            config.TARGET_UP_SUBJECT.format(aibox_name=aibox["name"]), body, aibox["recipients"]
        )

    def _send_aibox_status_change_email(
        self,
        aibox: dict,
        timestamp: str,
        changed_statuses: dict[str, str],
    ) -> None:
        prefix, heading_color = self._change_email_style(changed_statuses)
        body = config.AIBOX_STATUS_CHANGE_BODY_TEMPLATE.format(
            scope_name=aibox["name"],
            timestamp=timestamp,
            change_count=len(changed_statuses),
            heading_color=heading_color,
            aibox_rows=self._build_aibox_rows(aibox["targets"], self.aibox_status, changed_statuses),
        )
        self.email_alert.send_status_email(
            config.AIBOX_STATUS_CHANGE_SUBJECT.format(prefix=prefix, scope_name=aibox["name"]),
            body,
            aibox["recipients"],
        )

    def _send_target_status_change_email(
        self,
        aibox: dict,
        timestamp: str,
        changed_statuses: dict[str, str],
    ) -> None:
        prefix, heading_color = self._change_email_style(changed_statuses)
        body = config.TARGET_STATUS_CHANGE_BODY_TEMPLATE.format(
            hostname=aibox["name"],
            aibox_name=aibox["name"],
            aibox_ip=aibox["ip"],
            timestamp=timestamp,
            change_count=len(changed_statuses),
            heading_color=heading_color,
            target_rows=self._build_target_rows(aibox["targets"], self.target_status, changed_statuses, self._target_status_key(aibox)),
        )
        self.email_alert.send_status_email(
            config.TARGET_STATUS_CHANGE_SUBJECT.format(prefix=prefix, hostname=aibox["name"]),
            body,
            aibox["recipients"],
        )

    def _send_target_recovery_check_result_email(
        self,
        aibox: dict,
        timestamp: str,
        changed_statuses: dict[str, str],
        note: str = "",
    ) -> None:
        note_html = f'<p style="color:#6b7280;"><b>Ghi chú:</b> {escape(note)}</p>' if note else ""
        body = config.TARGET_RECOVERY_CHECK_RESULT_BODY_TEMPLATE.format(
            aibox_name=aibox["name"],
            aibox_ip=aibox["ip"],
            timestamp=timestamp,
            target_count=len(aibox["targets"]),
            change_count=len(changed_statuses),
            note_html=note_html,
            target_rows=self._build_target_rows(aibox["targets"], self.target_status, changed_statuses, self._target_status_key(aibox)),
        )
        self.email_alert.send_status_email(
            config.TARGET_RECOVERY_CHECK_RESULT_SUBJECT.format(aibox_name=aibox["name"]),
            body,
            aibox["recipients"],
        )

    def _send_target_status_summary_email(self, aibox: dict, timestamp: str) -> None:
        body = config.TARGET_STATUS_SUMMARY_BODY_TEMPLATE.format(
            aibox_name=aibox["name"],
            aibox_ip=aibox["ip"],
            timestamp=timestamp,
            target_rows=self._build_target_rows(aibox["targets"], self.target_status, {}, self._target_status_key(aibox)),
        )
        self.email_alert.send_status_email(
            config.TARGET_STATUS_SUMMARY_SUBJECT.format(aibox_name=aibox["name"]),
            body,
            aibox["recipients"],
        )

    @staticmethod
    def _build_resource_rows(resources: dict[str, float], over_threshold: dict[str, float]) -> str:
        rows = []
        for resource_name in ["CPU", "RAM", "NPU Core 0", "NPU Core 1", "NPU Core 2"]:
            usage = resources.get(resource_name, 0.0)
            threshold = AiboxMonitor._resource_threshold(resource_name)
            is_alert = resource_name in over_threshold
            bg = "background:#fee2e2;" if is_alert else ""
            color = "#b91c1c" if is_alert else "#15803d"
            status = "Vượt ngưỡng" if is_alert else "Bình thường"
            rows.append(
                f'<tr style="{bg}">'
                f'<td style="border:1px solid #ddd;padding:8px;font-weight:bold;">{escape(resource_name)}</td>'
                f'<td style="border:1px solid #ddd;padding:8px;color:{color};font-weight:bold;">{usage:.1f}%</td>'
                f'<td style="border:1px solid #ddd;padding:8px;">{threshold}%</td>'
                f'<td style="border:1px solid #ddd;padding:8px;color:{color};font-weight:bold;">{escape(status)}</td>'
                "</tr>"
            )
        return "\n".join(rows)

    def _send_resource_alert_email(
        self,
        aibox: dict,
        timestamp: str,
        resources: dict[str, float],
        over_threshold: dict[str, float],
    ) -> None:
        highest_resource, highest_usage = max(over_threshold.items(), key=lambda item: item[1])
        body = config.RESOURCE_ALERT_BODY_TEMPLATE.format(
            resource_name=", ".join(over_threshold),
            hostname=aibox["name"],
            timestamp=timestamp,
            usage=highest_usage,
            threshold=self._resource_threshold(highest_resource),
            resource_rows=self._build_resource_rows(resources, over_threshold),
        )
        self.email_alert.send_status_email(
            config.RESOURCE_ALERT_SUBJECT.format(hostname=aibox["name"]), body, aibox["recipients"]
        )

    def _send_resource_status_summary_email(self, aibox: dict, timestamp: str, resources: dict[str, float]) -> None:
        body = config.RESOURCE_STATUS_SUMMARY_BODY_TEMPLATE.format(
            hostname=aibox["name"],
            timestamp=timestamp,
            resource_rows=self._build_resource_rows(resources, {}),
        )
        self.email_alert.send_status_email(
            config.RESOURCE_STATUS_SUMMARY_SUBJECT.format(hostname=aibox["name"]), body, aibox["recipients"]
        )

    @staticmethod
    def _build_aibox_rows(
        aiboxes: dict[str, str],
        aibox_status: dict[str, bool],
        changed_statuses: dict[str, str],
    ) -> str:
        rows = []
        for ip_address, name in aiboxes.items():
            changed_status = changed_statuses.get(ip_address)
            cell_style = "border:1px solid #ddd;padding:8px;"
            if changed_status:
                highlight_bg = "#fee2e2" if changed_status == "Mất kết nối" else "#dcfce7"
                cell_style += f"background:{highlight_bg};font-weight:bold;"
            if changed_status:
                status = changed_status
                status_color = "#b91c1c" if changed_status == "Mất kết nối" else "#15803d"
                status_style = cell_style + f"color:{status_color};"
            elif ip_address in aibox_status:
                is_online = aibox_status[ip_address]
                status = "Đang kết nối" if is_online else "Mất kết nối"
                color = "#15803d" if is_online else "#b91c1c"
                status_style = cell_style + f"color:{color};font-weight:bold;"
            else:
                status = "Chưa ghi nhận"
                status_style = cell_style + "color:#6b7280;font-weight:bold;"
            rows.append(
                "<tr>"
                f'<td style="{status_style}">{escape(status)}</td>'
                f'<td style="{cell_style}">{escape(name)}</td>'
                f'<td style="{cell_style}">{escape(ip_address)}</td>'
                "</tr>"
            )
        return "\n".join(rows)

    def check_aiboxes(self) -> set[str]:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        aibox_configs = config.get_aibox_configs()
        checked_aibox_configs = []
        recovered_aibox_ips = set()
        for aibox in aibox_configs:
            if aibox["check-devices"] and aibox["local"]:
                checked_aibox_configs.append(aibox)
                logger.info(f"Running local AIBOX check: {aibox['name']} ({len(aibox['targets'])} targets)")
            elif not aibox["check-devices"]:
                logger.info(f"Skipping disabled AIBOX check: {aibox['name']} ({aibox.get('ip', '')})")
        if not checked_aibox_configs:
            logger.info("No local AIBOX checks configured")
        aiboxes = self._aibox_report_targets(checked_aibox_configs)
        all_changed_statuses = {}

        logger.info("Checking AIBOX connectivity...")
        for aibox in checked_aibox_configs:
            for ip_address, name in aibox["targets"].items():
                is_online = self._ping_host(ip_address)
                was_online = self.aibox_status.get(ip_address)
                state = "online" if is_online else "offline"

                if was_online is None:
                    logger.info(f"Initial AIBOX state: {name} ({ip_address}) is {state}")
                elif was_online and not is_online:
                    logger.warning(f"AIBOX offline: {name} ({ip_address})")
                    all_changed_statuses[ip_address] = "Mất kết nối"
                elif not was_online and is_online:
                    logger.info(f"AIBOX back online: {name} ({ip_address})")
                    all_changed_statuses[ip_address] = "Đã kết nối lại"
                    recovered_aibox_ips.add(ip_address)
                else:
                    logger.info(f"AIBOX unchanged: {name} ({ip_address}) is {state}")

                self.aibox_status[ip_address] = is_online

        if all_changed_statuses:
            for group_name, group in self._aibox_status_groups(checked_aibox_configs).items():
                group_changed_statuses = {
                    ip_address: status
                    for ip_address, status in all_changed_statuses.items()
                    if ip_address in group["targets"]
                }
                if not group_changed_statuses:
                    continue
                logger.info(
                    f"Sending grouped AIBOX status-change email for {group_name}: "
                    f"{len(group_changed_statuses)} change(s), "
                    f"{len(group['targets'])} target(s), {len(group['recipients'])} recipient(s)"
                )
                self._send_aibox_status_change_email(
                    {
                        "name": group.get("name", f"Nhóm AIBOX {group_name}"),
                        "recipients": group["recipients"],
                        "targets": group["targets"],
                    },
                    timestamp,
                    group_changed_statuses,
                )

        return recovered_aibox_ips

    def check_aibox_targets(self, recovered_aibox_ips: set[str] | None = None) -> None:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        recovered_aibox_ips = recovered_aibox_ips or set()

        logger.info("Checking devices behind AIBOXes...")
        for aibox in config.get_aibox_configs():
            if not aibox["check-devices"]:
                logger.info(f"Skipping disabled target checks: {aibox['name']} ({aibox.get('ip', '')})")
                continue
            if aibox["local"]:
                logger.info(f"Skipping local target checks: {aibox['name']}")
                continue
            status_key = self._target_status_key(aibox)
            newly_down = {}
            back_up = {}
            changed_statuses = {}
            checker_changes = {}
            checkers_by_ip = {}
            targets_by_checker = {}
            checked_targets = 0
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
                    if available_checkers[candidate_ip]:
                        checker = available_checkers[candidate_ip]
                        break
                if owner_ip:
                    if checker is None:
                        self._record_target_unknown(status_key, aibox, target_name, target_ip)
                        continue
                if checker is None and not owner_ip:
                    if not default_checker_loaded:
                        default_checker = self._select_target_checker(aibox, target_ip)
                        default_checker_loaded = True
                        if default_checker:
                            available_checkers[default_checker["ip"]] = default_checker
                    checker = default_checker
                if checker is None:
                    self._record_target_unknown(status_key, aibox, target_name, target_ip)
                    continue

                aibox_ip, user = checker["ip"], checker["user"]
                checkers_by_ip[aibox_ip] = checker
                targets_by_checker.setdefault(aibox_ip, {})[target_ip] = target_name
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
                target_change = None

                if was_online is None:
                    logger.info(f"Initial target state from {aibox['name']}: {target_name} ({target_ip}) is {state} [method={method}]{quality_tag}")
                elif was_online and not is_online:
                    logger.warning(f"Target offline from {aibox['name']}: {target_name} ({target_ip}) [method={method}]{quality_tag}")
                    newly_down[target_ip] = "Mất kết nối"
                    target_change = newly_down[target_ip]
                elif not was_online and is_online:
                    logger.info(f"Target back online from {aibox['name']}: {target_name} ({target_ip}) [method={method}]{quality_tag}")
                    back_up[target_ip] = "Đã kết nối lại"
                    target_change = back_up[target_ip]
                else:
                    logger.info(f"Target unchanged from {aibox['name']}: {target_name} ({target_ip}) is {state} [method={method}]{quality_tag}")

                self.target_status[key] = is_online
                self.target_last_known_status[key] = is_online
                self.unknown_target_status.discard(key)
                if target_change:
                    changed_statuses[target_ip] = target_change
                    checker_changes.setdefault(aibox_ip, {})[target_ip] = target_change
            if checked_targets:
                logger.info(f"Target checks completed from {aibox['name']}: {checked_targets} target(s)")
            else:
                self._scope_unknown(aibox, "no checker available")
            email_checker_ips = set(checker_changes)
            email_checker_ips.update(checker_ip for checker_ip in targets_by_checker if checker_ip in recovered_aibox_ips)
            for checker_ip in email_checker_ips:
                checker = checkers_by_ip.get(checker_ip)
                if not checker:
                    continue
                email_aibox = {
                    **aibox,
                    "ip": checker["ip"],
                    "user": checker["user"],
                    "targets": targets_by_checker[checker_ip],
                }
                changes = checker_changes.get(checker_ip, {})
                if checker_ip in recovered_aibox_ips:
                    self._send_target_recovery_check_result_email(email_aibox, timestamp, changes)
                elif changes:
                    self._send_target_status_change_email(email_aibox, timestamp, changes)

    def _record_target_unknown(self, status_key: str, aibox: dict, target_name: str, target_ip: str) -> None:
        key = self._target_key(status_key, target_ip)
        if key not in self.unknown_target_status:
            logger.info(f"Target state unknown from {aibox['name']}: {target_name} ({target_ip}) [method=unknown]")
        self.unknown_target_status.add(key)

    def _current_target_status(self, key: str):
        if key in self.unknown_target_status:
            return None
        return self.target_status.get(key)

    def _scope_unknown(self, aibox: dict, reason: str) -> None:
        status_key = self._target_status_key(aibox)
        for target_ip, target_name in aibox.get("targets", {}).items():
            self._record_target_unknown(status_key, aibox, target_name, target_ip)
        logger.warning(f"Target checks unavailable from {aibox['name']}: {reason}")

    def check_aibox_resources(self) -> None:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        logger.info("Checking AIBOX resource usage...")
        for aibox in config.get_aibox_configs():
            if not aibox["check-resource"]:
                continue
            if aibox["local"]:
                logger.info(f"Skipping local resource checks: {aibox['name']}")
                continue

            aibox_ip = aibox["ip"]
            user = aibox["user"]
            is_online = self.aibox_status.get(aibox_ip)
            if is_online is None:
                is_online = self._ping_host(aibox_ip)
                self.aibox_status[aibox_ip] = is_online
            if not is_online:
                logger.warning(f"Skipping resource checks because AIBOX is offline: {aibox['name']} ({aibox_ip})")
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
                self._send_resource_alert_email(aibox, timestamp, resources, over_threshold)
            else:
                logger.info(f"Resource usage normal for {aibox['name']}: {resources}")

    def send_scheduled_status_summaries(self) -> None:
        now = datetime.now()
        summary_slot = self._status_summary_slot(now)
        if summary_slot is None or summary_slot == self.last_status_summary_slot:
            return

        timestamp = now.strftime("%Y-%m-%d %H:%M:%S")
        logger.info(f"Sending scheduled status summaries for slot {summary_slot}")
        aibox_configs = config.get_aibox_configs()
        aibox_status_groups = self._aibox_status_groups(aibox_configs)
        for group_name, group in aibox_status_groups.items():
            logger.info(f"Sending scheduled AIBOX status summary for {group_name}")
            self._send_status_summary_email(
                timestamp,
                group["recipients"],
                group["targets"],
            )

        for aibox in aibox_configs:
            if aibox["local"]:
                continue

            if aibox["check-devices"]:
                checker = self._select_target_checker(aibox)
                if checker is None:
                    logger.warning(f"Skipping scheduled target summary because no checker is available: {aibox['name']}")
                else:
                    self._send_target_status_summary_email({**aibox, "ip": checker["ip"], "user": checker["user"]}, timestamp)

            if aibox["check-resource"] and not aibox["local"]:
                aibox_ip = aibox["ip"]
                user = aibox["user"]
                resources = self.resource_status.get(aibox_ip)
                if not self.aibox_status.get(aibox_ip, False):
                    logger.warning(f"Skipping scheduled resource summary because AIBOX is offline: {aibox['name']} ({aibox_ip})")
                elif not self._can_ssh(user, aibox_ip):
                    logger.warning(f"Skipping scheduled resource summary because SSH is unavailable: {user}@{aibox_ip}")
                elif resources is None:
                    logger.warning(f"Skipping scheduled resource summary because resource data is unavailable: {aibox['name']} ({aibox_ip})")
                else:
                    self._send_resource_status_summary_email(aibox, timestamp, resources)

        self.last_status_summary_slot = summary_slot

    def run(self) -> None:
        self.running = True
        logger.info("=" * 50)
        logger.info("AIBOX Monitor Started")
        logger.info(f"Ping interval: {config.PING_INTERVAL_SECONDS}s")
        logger.info("=" * 50)

        while self.running:
            recovered_aibox_ips = self.check_aiboxes()
            self.check_aibox_targets(recovered_aibox_ips=recovered_aibox_ips)
            self.check_aibox_resources()
            self.send_scheduled_status_summaries()
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
