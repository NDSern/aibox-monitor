import logging
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
        self.next_status_summary_at = time.monotonic() + config.STATUS_SUMMARY_INTERVAL_SECONDS
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

    def check_aiboxes(self) -> None:
        hostname = socket.gethostname()
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        aibox_configs = config.get_aibox_configs()
        aiboxes = {aibox["ip"]: aibox["name"] for aibox in aibox_configs}

        logger.info("Checking AIBOX connectivity...")
        for aibox in aibox_configs:
            ip_address = aibox["ip"]
            name = aibox["name"]
            is_online = self._ping_host(ip_address)
            was_online = self.aibox_status.get(ip_address)
            state = "online" if is_online else "offline"

            if was_online is None:
                logger.info(f"Initial AIBOX state: {name} ({ip_address}) is {state}")
            elif was_online and not is_online:
                logger.warning(f"AIBOX offline: {name} ({ip_address})")
                self._send_down_email(ip_address, name, hostname, timestamp, aibox["recipients"], aiboxes)
            elif not was_online and is_online:
                logger.info(f"AIBOX back online: {name} ({ip_address})")
                self._send_up_email(ip_address, name, hostname, timestamp, aibox["recipients"], aiboxes)
            else:
                logger.info(f"AIBOX unchanged: {name} ({ip_address}) is {state}")

            self.aibox_status[ip_address] = is_online

        now = time.monotonic()
        if now >= self.next_status_summary_at:
            logger.info("Sending scheduled AIBOX status summary email")
            for aibox in aibox_configs:
                self._send_status_summary_email(timestamp, aibox["recipients"], aiboxes)
            self.next_status_summary_at = now + config.STATUS_SUMMARY_INTERVAL_SECONDS

    def check_aibox_targets(self) -> None:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        logger.info("Checking devices behind AIBOXes...")
        for aibox in config.get_aibox_configs():
            aibox_ip = aibox["ip"]
            user = aibox["user"]
            if not self.aibox_status.get(aibox_ip, False):
                logger.warning(f"Skipping target checks because AIBOX is offline: {aibox['name']} ({aibox_ip})")
                continue
            if not self._can_ssh(user, aibox_ip):
                logger.warning(f"Skipping target checks because SSH is unavailable: {user}@{aibox_ip}")
                continue

            newly_down = {}
            back_up = {}
            for target_ip, target_name in aibox["targets"].items():
                if not self._ping_host(target_ip):
                    logger.warning(f"Skipping SSH ping because target is not locally reachable: {target_name} ({target_ip})")
                    continue

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
                self._send_target_down_email(aibox, timestamp, newly_down)
            if back_up:
                self._send_target_up_email(aibox, timestamp, back_up)

    def run(self) -> None:
        self.running = True
        logger.info("=" * 50)
        logger.info("AIBOX Monitor Started")
        logger.info(f"Ping interval: {config.PING_INTERVAL_SECONDS}s")
        logger.info("=" * 50)

        while self.running:
            self.check_aiboxes()
            self.check_aibox_targets()
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
