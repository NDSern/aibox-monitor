import logging
import json
import signal
import socket
import subprocess
import sys
import time
from datetime import datetime
from html import escape

import config
from email_alert import EmailAlert

logging.basicConfig(
    level=getattr(logging, config.LOG_LEVEL),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler(config.LOG_FILE),
        logging.StreamHandler(sys.stdout),
    ],
)

logger = logging.getLogger(__name__)


class AiboxMonitor:
    def __init__(self):
        self.email_alert = EmailAlert()
        self.aibox_status = {}
        self.target_status = {}
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
    def _target_key(aibox_ip: str, target_ip: str) -> str:
        return f"{aibox_ip}:{target_ip}"

    @staticmethod
    def _can_ssh(user: str, aibox_ip: str) -> bool:
        if not user or not aibox_ip:
            return False

        try:
            result = subprocess.run(
                [
                    "ssh",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=5",
                    "-o",
                    "StrictHostKeyChecking=accept-new",
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
    def _ping_target_from_aibox(user: str, aibox_ip: str, target_ip: str) -> bool:
        try:
            result = subprocess.run(
                [
                    "ssh",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=5",
                    "-o",
                    "StrictHostKeyChecking=accept-new",
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
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=5",
                    "-o",
                    "StrictHostKeyChecking=accept-new",
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

    @staticmethod
    def _build_target_rows(
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
            is_online = target_status.get(key)
            if status is None and is_online is not None:
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
            target_rows=self._build_target_rows(aibox["targets"], self.target_status, changed_statuses, aibox["ip"]),
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
            target_rows=self._build_target_rows(aibox["targets"], self.target_status, changed_statuses, aibox["ip"]),
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
            target_rows=self._build_target_rows(aibox["targets"], self.target_status, changed_statuses, aibox["ip"]),
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
            target_rows=self._build_target_rows(aibox["targets"], self.target_status, changed_statuses, aibox["ip"]),
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
            target_rows=self._build_target_rows(aibox["targets"], self.target_status, {}, aibox["ip"]),
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
        aiboxes = {
            ip_address: name
            for aibox in checked_aibox_configs
            for ip_address, name in aibox["targets"].items()
        }

        logger.info("Checking AIBOX connectivity...")
        for aibox in checked_aibox_configs:
            changed_statuses = {}
            for ip_address, name in aibox["targets"].items():
                is_online = self._ping_host(ip_address)
                was_online = self.aibox_status.get(ip_address)
                state = "online" if is_online else "offline"

                if was_online is None:
                    logger.info(f"Initial AIBOX state: {name} ({ip_address}) is {state}")
                elif was_online and not is_online:
                    logger.warning(f"AIBOX offline: {name} ({ip_address})")
                    changed_statuses[ip_address] = "Mất kết nối"
                elif not was_online and is_online:
                    logger.info(f"AIBOX back online: {name} ({ip_address})")
                    changed_statuses[ip_address] = "Đã kết nối lại"
                    recovered_aibox_ips.add(ip_address)
                else:
                    logger.info(f"AIBOX unchanged: {name} ({ip_address}) is {state}")

                self.aibox_status[ip_address] = is_online

            if changed_statuses:
                logger.info(f"Sending batched AIBOX status-change email for {aibox['name']}: {len(changed_statuses)} change(s)")
                self._send_aibox_status_change_email(aibox, timestamp, changed_statuses)

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
            aibox_ip = aibox["ip"]
            user = aibox["user"]
            send_recovery_result = aibox_ip in recovered_aibox_ips
            if not self.aibox_status.get(aibox_ip, False):
                logger.warning(f"Skipping target checks because AIBOX is offline: {aibox['name']} ({aibox_ip})")
                continue
            if not self._can_ssh(user, aibox_ip):
                logger.warning(f"Skipping target checks because SSH is unavailable: {user}@{aibox_ip}")
                continue

            newly_down = {}
            back_up = {}
            for target_ip, target_name in aibox["targets"].items():
                is_online = self._ping_target_from_aibox(user, aibox_ip, target_ip)
                key = self._target_key(aibox_ip, target_ip)
                was_online = self.target_status.get(key)
                state = "online" if is_online else "offline"

                if was_online is None:
                    logger.info(f"Initial target state from {aibox['name']}: {target_name} ({target_ip}) is {state}")
                elif was_online and not is_online:
                    logger.warning(f"Target offline from {aibox['name']}: {target_name} ({target_ip})")
                    newly_down[target_ip] = "Mất kết nối"
                elif not was_online and is_online:
                    logger.info(f"Target back online from {aibox['name']}: {target_name} ({target_ip})")
                    back_up[target_ip] = "Đã kết nối lại"
                else:
                    logger.info(f"Target unchanged from {aibox['name']}: {target_name} ({target_ip}) is {state}")

                self.target_status[key] = is_online

            if newly_down:
                logger.info(f"Queued target down changes for {aibox['name']}: {len(newly_down)}")
            if back_up:
                logger.info(f"Queued target recovery changes for {aibox['name']}: {len(back_up)}")
            changed_statuses = {**newly_down, **back_up}
            if send_recovery_result:
                logger.info(
                    f"Sending target recovery check result email for {aibox['name']}: "
                    f"{len(aibox['targets'])} target(s), {len(changed_statuses)} change(s)"
                )
                self._send_target_recovery_check_result_email(aibox, timestamp, changed_statuses)
            elif changed_statuses:
                logger.info(f"Sending batched target status-change email for {aibox['name']}: {len(changed_statuses)} change(s)")
                self._send_target_status_change_email(aibox, timestamp, changed_statuses)

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
            if not self._ping_host(aibox_ip):
                logger.warning(f"Skipping resource checks because AIBOX is offline: {aibox['name']} ({aibox_ip})")
                self.aibox_status[aibox_ip] = False
                continue
            self.aibox_status[aibox_ip] = True

            if not self._can_ssh(user, aibox_ip):
                logger.warning(f"Skipping resource checks because SSH is unavailable: {user}@{aibox_ip}")
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
        for aibox in config.get_aibox_configs():
            if aibox["check-devices"] and aibox["local"]:
                self._send_status_summary_email(timestamp, aibox["recipients"], aibox["targets"])
                continue

            if aibox["check-devices"]:
                aibox_ip = aibox["ip"]
                user = aibox["user"]
                if not self.aibox_status.get(aibox_ip, False):
                    logger.warning(f"Skipping scheduled target summary because AIBOX is offline: {aibox['name']} ({aibox_ip})")
                elif not self._can_ssh(user, aibox_ip):
                    logger.warning(f"Skipping scheduled target summary because SSH is unavailable: {user}@{aibox_ip}")
                else:
                    self._send_target_status_summary_email(aibox, timestamp)

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
