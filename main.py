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
        aiboxes = config.get_aiboxes()
        recipients = config.get_recipient_emails()

        logger.info("Checking AIBOX connectivity...")
        for ip_address, name in aiboxes.items():
            is_online = self._ping_host(ip_address)
            was_online = self.aibox_status.get(ip_address)
            state = "online" if is_online else "offline"

            if was_online is None:
                logger.info(f"Initial AIBOX state: {name} ({ip_address}) is {state}")
            elif was_online and not is_online:
                logger.warning(f"AIBOX offline: {name} ({ip_address})")
                self._send_down_email(ip_address, name, hostname, timestamp, recipients, aiboxes)
            elif not was_online and is_online:
                logger.info(f"AIBOX back online: {name} ({ip_address})")
                self._send_up_email(ip_address, name, hostname, timestamp, recipients, aiboxes)
            else:
                logger.info(f"AIBOX unchanged: {name} ({ip_address}) is {state}")

            self.aibox_status[ip_address] = is_online

        now = time.monotonic()
        if now >= self.next_status_summary_at:
            logger.info("Sending scheduled AIBOX status summary email")
            self._send_status_summary_email(timestamp, recipients, aiboxes)
            self.next_status_summary_at = now + config.STATUS_SUMMARY_INTERVAL_SECONDS

    def run(self) -> None:
        self.running = True
        logger.info("=" * 50)
        logger.info("AIBOX Monitor Started")
        logger.info(f"Ping interval: {config.PING_INTERVAL_SECONDS}s")
        logger.info("=" * 50)

        while self.running:
            self.check_aiboxes()
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
