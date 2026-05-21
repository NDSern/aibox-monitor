import json
import logging
import os
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

PING_INTERVAL_SECONDS = 3 * 60
PING_TIMEOUT_SECONDS = 2
STATUS_SUMMARY_HOURS = {0, 6, 12, 18}
CPU_THRESHOLD = 90
RAM_THRESHOLD = 90
NPU_THRESHOLD = 90

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
DEFAULT_AIBOXES = {
    "100.64.0.49": "Cảng Gia Vũ - Hải Phòng",
}
AIBOXES_FILE = os.getenv("AIBOXES_FILE", "aiboxes.json")
AIBOX_CONFIG_FILE = os.getenv("AIBOX_CONFIG_FILE", "config.json")
AIBOXES = DEFAULT_AIBOXES
RECIPIENTS_FILE = os.getenv("RECIPIENTS_FILE", "recipients.json")
RECIPIENT_EMAILS = DEFAULT_RECIPIENT_EMAILS

_aiboxes_cache = DEFAULT_AIBOXES
_aibox_config_cache = []
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


def _is_valid_target_map(value) -> bool:
    return (
        isinstance(value, dict)
        and all(isinstance(ip, str) and ip for ip in value)
        and all(isinstance(name, str) and name for name in value.values())
    )


def _is_valid_aibox_config(value) -> bool:
    return _aibox_config_error(value) is None


def _aibox_config_error(value) -> str | None:
    if not (
        isinstance(value, dict)
        and isinstance(value.get("name"), str)
        and bool(value["name"])
    ):
        return "must be an object with non-empty name"

    if not _is_valid_recipients(value.get("recipients")):
        return "recipients must be a non-empty list of email strings"

    if "targets" in value and not _is_valid_target_map(value["targets"]):
        return "targets must be an object of IP/name strings"

    check_devices = value.get("check-devices", False)
    if not isinstance(check_devices, bool):
        return "check-devices must be a boolean when present"

    check_resource = value.get("check-resource", False)
    if not isinstance(check_resource, bool):
        return "check-resource must be a boolean when present"

    local = value.get("local", False)
    if not isinstance(local, bool):
        return "local must be a boolean when present"

    if local:
        return None

    if not check_devices and not check_resource:
        return None

    if not (isinstance(value.get("user"), str) and bool(value["user"])):
        return "non-local enabled checks require non-empty user"
    if not (isinstance(value.get("ip"), str) and bool(value["ip"])):
        return "non-local enabled checks require non-empty ip"

    return None


def _is_valid_aibox_config_list(value) -> bool:
    return isinstance(value, list) and all(_is_valid_aibox_config(item) for item in value)


def _aibox_config_list_error(value) -> str | None:
    if not isinstance(value, list):
        return "top-level config must be a list"
    for index, item in enumerate(value):
        error = _aibox_config_error(item)
        if error:
            name = item.get("name", "<unknown>") if isinstance(item, dict) else "<not object>"
            return f"item {index} ({name}): {error}"
    return None


def _normalize_v2_config(value: dict) -> list[dict]:
    default_recipients = value.get("aibox_report_recipients") or value.get("default_recipients") or DEFAULT_RECIPIENT_EMAILS
    if not _is_valid_recipients(default_recipients):
        raise ValueError("v2 default recipients must be a non-empty list of email strings")
    aiboxes = value.get("aiboxes")
    target_scopes = value.get("target_scopes", [])
    if not isinstance(aiboxes, list) or not isinstance(target_scopes, list):
        raise ValueError("v2 config requires aiboxes and target_scopes lists")

    normalized = [
        {
            "name": "Kiểm tra trạng thái các AIBOX",
            "check-devices": True,
            "check-resource": False,
            "local": True,
            "user": "",
            "ip": "",
            "recipients": list(default_recipients),
            "targets": {item["ip"]: item["name"] for item in aiboxes},
        }
    ]

    for item in aiboxes:
        recipients = item.get("recipients") or default_recipients
        normalized.append(
            {
                "id": item.get("id", item["ip"]),
                "name": item["name"],
                "check-devices": False,
                "check-resource": item.get("check-resource", False),
                "local": False,
                "user": item.get("user", ""),
                "ip": item["ip"],
                "recipients": list(recipients),
                "targets": {},
            }
        )

    for scope in target_scopes:
        networks = [scope["id"]]
        checkers = [
            {
                "name": item["name"],
                "user": item.get("user", ""),
                "ip": item["ip"],
            }
            for item in aiboxes
            if item.get("check-devices", False) and any(network in item.get("networks", []) for network in networks)
        ]
        recipients = scope.get("recipients") or default_recipients
        normalized.append(
            {
                "id": scope["id"],
                "name": scope["name"],
                "check-devices": True,
                "check-resource": False,
                "local": False,
                "user": checkers[0]["user"] if checkers else "",
                "ip": checkers[0]["ip"] if checkers else "",
                "recipients": list(recipients),
                "targets": dict(scope.get("targets", {})),
                "checkers": checkers,
            }
        )

    return normalized


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


def get_aibox_configs() -> list[dict]:
    global _aibox_config_cache

    try:
        aibox_configs = _load_json_file(AIBOX_CONFIG_FILE)
        if isinstance(aibox_configs, dict) and aibox_configs.get("version") == 2:
            aibox_configs = _normalize_v2_config(aibox_configs)
        config_error = _aibox_config_list_error(aibox_configs)
        if config_error:
            raise ValueError(f"AIBOX config JSON invalid: {config_error}")
        _aibox_config_cache = []
        for item in aibox_configs:
            normalized_item = {
                "name": item["name"],
                "check-devices": item.get("check-devices", False),
                "check-resource": item.get("check-resource", False),
                "local": item.get("local", False),
                "user": item.get("user", ""),
                "ip": item.get("ip", ""),
                "recipients": list(item["recipients"]),
                "targets": dict(item.get("targets", {})),
            }
            if "id" in item:
                normalized_item["id"] = item["id"]
            if "checkers" in item:
                normalized_item["checkers"] = list(item["checkers"])
            _aibox_config_cache.append(normalized_item)
    except (OSError, json.JSONDecodeError, ValueError) as e:
        logger.warning(f"Using cached AIBOX target config after failed JSON load: {e}")

    configs = []
    for item in _aibox_config_cache:
        config_item = {
            "name": item["name"],
            "check-devices": item.get("check-devices", False),
            "check-resource": item.get("check-resource", False),
            "local": item.get("local", False),
            "user": item.get("user", ""),
            "ip": item.get("ip", ""),
            "recipients": list(item["recipients"]),
            "targets": dict(item.get("targets", {})),
        }
        if "id" in item:
            config_item["id"] = item["id"]
        if "checkers" in item:
            config_item["checkers"] = list(item["checkers"])
        configs.append(config_item)
    return configs

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

AIBOX_STATUS_CHANGE_SUBJECT = "[{prefix}] Tổng hợp thay đổi trạng thái AIBOX - {scope_name}"
AIBOX_STATUS_CHANGE_BODY_TEMPLATE = """
<html><body style="font-family:Arial,sans-serif;color:#1f2937;">
<h2 style="color:{heading_color};">Tổng hợp thay đổi trạng thái AIBOX</h2>
<p><b>Phạm vi:</b> {scope_name}</p>
<p><b>Thời gian:</b> {timestamp}</p>
<p><b>Số thay đổi:</b> {change_count}</p>
<table style="border-collapse:collapse;width:100%;max-width:760px;">
  <tr style="background:#f3f4f6;"><th style="border:1px solid #ddd;padding:8px;text-align:left;">Trạng thái</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">AIBOX</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">IP</th></tr>
  {aibox_rows}
</table>
</body></html>
"""

STATUS_SUMMARY_SUBJECT = "[BÁO CÁO] Trạng thái AIBOX hiện tại - Cảng Gia Vũ - Hải Phòng"
STATUS_SUMMARY_BODY_TEMPLATE = """
<html><body style="font-family:Arial,sans-serif;color:#1f2937;">
<h2 style="color:#1d4ed8;">Trạng thái AIBOX hiện tại</h2>
<p><b>Thời gian:</b> {timestamp}</p>
<p>Báo cáo tự động lúc 0h, 6h, 12h và 18h.</p>
<table style="border-collapse:collapse;width:100%;max-width:760px;">
  <tr style="background:#f3f4f6;"><th style="border:1px solid #ddd;padding:8px;text-align:left;">Trạng thái</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">AIBOX</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">IP</th></tr>
  {aibox_rows}
</table>
</body></html>
"""

TARGET_DOWN_SUBJECT = "[CẢNH BÁO] Thiết bị sau khi AIBOX mất kết nối - {aibox_name}"
TARGET_DOWN_BODY_TEMPLATE = """
<html><body style="font-family:Arial,sans-serif;color:#1f2937;">
<h2 style="color:#b91c1c;">Thiết bị sau khi AIBOX mất kết nối</h2>
<p><b>AIBOX:</b> {aibox_name}</p>
<p><b>IP AIBOX:</b> {aibox_ip}</p>
<p><b>Thời gian:</b> {timestamp}</p>
<table style="border-collapse:collapse;width:100%;max-width:760px;">
  <tr style="background:#f3f4f6;"><th style="border:1px solid #ddd;padding:8px;text-align:left;">Trạng thái</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">Tên camera</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">IP</th></tr>
  {target_rows}
</table>
<p style="color:#b91c1c;font-weight:bold;">Vui lòng kiểm tra ngay.</p>
</body></html>
"""

TARGET_UP_SUBJECT = "[KHÔI PHỤC] Thiết bị sau khi AIBOX đã kết nối lại - {aibox_name}"
TARGET_UP_BODY_TEMPLATE = """
<html><body style="font-family:Arial,sans-serif;color:#1f2937;">
<h2 style="color:#15803d;">Thiết bị sau khi AIBOX đã kết nối lại</h2>
<p><b>AIBOX:</b> {aibox_name}</p>
<p><b>IP AIBOX:</b> {aibox_ip}</p>
<p><b>Thời gian:</b> {timestamp}</p>
<table style="border-collapse:collapse;width:100%;max-width:760px;">
  <tr style="background:#f3f4f6;"><th style="border:1px solid #ddd;padding:8px;text-align:left;">Trạng thái</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">Tên camera</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">IP</th></tr>
  {target_rows}
</table>
</body></html>
"""

TARGET_STATUS_CHANGE_SUBJECT = "[{prefix}] Tổng hợp thay đổi các thiết bị ở {hostname}"
TARGET_STATUS_CHANGE_BODY_TEMPLATE = """
<html><body style="font-family:Arial,sans-serif;color:#1f2937;">
<h2 style="color:{heading_color};">Tổng hợp thay đổi các thiết bị ở {hostname}</h2>
<p><b>AIBOX:</b> {aibox_name}</p>
<p><b>IP AIBOX:</b> {aibox_ip}</p>
<p><b>Thời gian:</b> {timestamp}</p>
<p><b>Số thay đổi:</b> {change_count}</p>
<table style="border-collapse:collapse;width:100%;max-width:760px;">
  <tr style="background:#f3f4f6;"><th style="border:1px solid #ddd;padding:8px;text-align:left;">Trạng thái</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">Tên camera</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">IP</th></tr>
  {target_rows}
</table>
</body></html>
"""

TARGET_RECOVERY_CHECK_RESULT_SUBJECT = "[THÔNG TIN] Kết quả kiểm tra thiết bị sau khi AIBOX khôi phục - {aibox_name}"
TARGET_RECOVERY_CHECK_RESULT_BODY_TEMPLATE = """
<html><body style="font-family:Arial,sans-serif;color:#1f2937;">
<h2 style="color:#1d4ed8;">Kết quả kiểm tra thiết bị sau khi AIBOX khôi phục</h2>
<p><b>AIBOX:</b> {aibox_name}</p>
<p><b>IP AIBOX:</b> {aibox_ip}</p>
<p><b>Thời gian:</b> {timestamp}</p>
<p><b>Số thiết bị:</b> {target_count}</p>
<p><b>Số thay đổi:</b> {change_count}</p>
{note_html}
<table style="border-collapse:collapse;width:100%;max-width:760px;">
  <tr style="background:#f3f4f6;"><th style="border:1px solid #ddd;padding:8px;text-align:left;">Trạng thái</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">Tên camera</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">IP</th></tr>
  {target_rows}
</table>
</body></html>
"""

TARGET_STATUS_SUMMARY_SUBJECT = "[BÁO CÁO] Trạng thái thiết bị sau AIBOX hiện tại - {aibox_name}"
TARGET_STATUS_SUMMARY_BODY_TEMPLATE = """
<html><body style="font-family:Arial,sans-serif;color:#1f2937;">
<h2 style="color:#1d4ed8;">Trạng thái thiết bị sau AIBOX hiện tại</h2>
<p><b>AIBOX:</b> {aibox_name}</p>
<p><b>IP AIBOX:</b> {aibox_ip}</p>
<p><b>Thời gian:</b> {timestamp}</p>
<p>Báo cáo tự động lúc 0h, 6h, 12h và 18h.</p>
<table style="border-collapse:collapse;width:100%;max-width:760px;">
  <tr style="background:#f3f4f6;"><th style="border:1px solid #ddd;padding:8px;text-align:left;">Trạng thái</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">Tên camera</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">IP</th></tr>
  {target_rows}
</table>
</body></html>
"""

RESOURCE_ALERT_SUBJECT = "[CẢNH BÁO] Tài nguyên AIBOX vượt ngưỡng - {hostname}"
RESOURCE_ALERT_BODY_TEMPLATE = """
<html><body style="font-family:Arial,sans-serif;color:#1f2937;">
<h2 style="color:#b91c1c;">Cảnh báo tài nguyên AIBOX vượt ngưỡng</h2>
<p><b>AIBOX:</b> {hostname}</p>
<p><b>Thời gian:</b> {timestamp}</p>
<p><b>Tài nguyên vượt ngưỡng:</b> {resource_name}</p>
<p><b>Mức sử dụng cao nhất:</b> {usage:.1f}%</p>
<p><b>Ngưỡng cảnh báo:</b> {threshold}%</p>
<table style="border-collapse:collapse;width:100%;max-width:760px;">
  <tr style="background:#f3f4f6;"><th style="border:1px solid #ddd;padding:8px;text-align:left;">Tài nguyên</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">Mức sử dụng</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">Ngưỡng</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">Trạng thái</th></tr>
  {resource_rows}
</table>
<p style="color:#b91c1c;font-weight:bold;">Vui lòng kiểm tra ngay.</p>
</body></html>
"""

RESOURCE_STATUS_SUMMARY_SUBJECT = "[BÁO CÁO] Tài nguyên AIBOX hiện tại - {hostname}"
RESOURCE_STATUS_SUMMARY_BODY_TEMPLATE = """
<html><body style="font-family:Arial,sans-serif;color:#1f2937;">
<h2 style="color:#1d4ed8;">Tài nguyên AIBOX hiện tại</h2>
<p><b>AIBOX:</b> {hostname}</p>
<p><b>Thời gian:</b> {timestamp}</p>
<p>Báo cáo tự động lúc 0h, 6h, 12h và 18h.</p>
<table style="border-collapse:collapse;width:100%;max-width:760px;">
  <tr style="background:#f3f4f6;"><th style="border:1px solid #ddd;padding:8px;text-align:left;">Tài nguyên</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">Mức sử dụng</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">Ngưỡng</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">Trạng thái</th></tr>
  {resource_rows}
</table>
</body></html>
"""

LOG_FILE = "aibox_monitor.log"
LOG_LEVEL = "INFO"
