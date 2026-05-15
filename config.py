import json
import logging
import os
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

PING_INTERVAL_SECONDS = 3 * 60
PING_TIMEOUT_SECONDS = 2

DEFAULT_AIBOXES = {
    "100.64.0.49": "Cảng Gia Vũ - Hải Phòng",
}
AIBOXES_FILE = os.getenv("AIBOXES_FILE", "aiboxes.json")
AIBOXES = DEFAULT_AIBOXES

EMAIL_ENABLED = True
SMTP_SERVER = "smtp.office365.com"
SMTP_PORT = 587
EMAIL_USE_TLS = True
SENDER_EMAIL = os.getenv("SENDER_EMAIL", "")
SENDER_PASSWORD = os.getenv("SENDER_PASSWORD", "")
DEFAULT_RECIPIENT_EMAILS = [
    "sondn@vns.ai.vn",
    "huylq@vns.ai.vn",
]
RECIPIENTS_FILE = os.getenv("RECIPIENTS_FILE", "recipients.json")
RECIPIENT_EMAILS = DEFAULT_RECIPIENT_EMAILS

_aiboxes_cache = DEFAULT_AIBOXES
_recipients_cache = DEFAULT_RECIPIENT_EMAILS


def _load_json_file(file_path: str):
    with open(file_path, encoding="utf-8") as f:
        return json.load(f)


def _is_valid_aiboxes(value) -> bool:
    return (
        isinstance(value, dict)
        and bool(value)
        and all(isinstance(ip, str) and ip for ip in value)
        and all(isinstance(name, str) and name for name in value.values())
    )


def _is_valid_recipients(value) -> bool:
    return (
        isinstance(value, list)
        and bool(value)
        and all(isinstance(email, str) and email for email in value)
    )


def get_aiboxes() -> dict[str, str]:
    global _aiboxes_cache

    try:
        aiboxes = _load_json_file(AIBOXES_FILE)
        if not _is_valid_aiboxes(aiboxes):
            raise ValueError("AIBOX JSON must be a non-empty object of IP/name strings")
        _aiboxes_cache = dict(aiboxes)
    except (OSError, json.JSONDecodeError, ValueError) as e:
        logger.warning(f"Using cached AIBOX config after failed JSON load: {e}")

    return dict(_aiboxes_cache)


def get_recipient_emails() -> list[str]:
    global _recipients_cache

    try:
        recipients = _load_json_file(RECIPIENTS_FILE)
        if not _is_valid_recipients(recipients):
            raise ValueError("Recipients JSON must be a non-empty list of email strings")
        _recipients_cache = list(recipients)
    except (OSError, json.JSONDecodeError, ValueError) as e:
        logger.warning(f"Using cached recipient config after failed JSON load: {e}")

    return list(_recipients_cache)

DOWN_SUBJECT = "[CẢNH BÁO] AIBOX mất kết nối - Cảng Gia Vũ - Hải Phòng"
DOWN_BODY_TEMPLATE = """
<html><body style="font-family:Arial,sans-serif;color:#1f2937;">
<h2 style="color:#b91c1c;">AIBOX mất kết nối</h2>
<p><b>Thời gian:</b> {timestamp}</p>
<table style="border-collapse:collapse;width:100%;max-width:760px;">
  <tr style="background:#f3f4f6;"><th style="border:1px solid #ddd;padding:8px;text-align:left;">Trạng thái</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">AIBOX</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">IP</th></tr>
  {aibox_rows}
</table>
<p style="color:#b91c1c;font-weight:bold;">Vui lòng kiểm tra ngay.</p>
</body></html>
"""

UP_SUBJECT = "[KHÔI PHỤC] AIBOX đã kết nối lại - Cảng Gia Vũ - Hải Phòng"
UP_BODY_TEMPLATE = """
<html><body style="font-family:Arial,sans-serif;color:#1f2937;">
<h2 style="color:#15803d;">AIBOX đã kết nối lại</h2>
<p><b>Thời gian:</b> {timestamp}</p>
<table style="border-collapse:collapse;width:100%;max-width:760px;">
  <tr style="background:#f3f4f6;"><th style="border:1px solid #ddd;padding:8px;text-align:left;">Trạng thái</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">AIBOX</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">IP</th></tr>
  {aibox_rows}
</table>
</body></html>
"""

LOG_FILE = "aibox_monitor.log"
LOG_LEVEL = "INFO"
