import os
from dotenv import load_dotenv

load_dotenv()

PING_INTERVAL_SECONDS = 3 * 60
PING_TIMEOUT_SECONDS = 2

AIBOXES = {
    "100.64.0.49": "Cảng Gia Vũ - Hải Phòng",
}

EMAIL_ENABLED = True
SMTP_SERVER = "smtp.office365.com"
SMTP_PORT = 587
EMAIL_USE_TLS = True
SENDER_EMAIL = os.getenv("SENDER_EMAIL", "")
SENDER_PASSWORD = os.getenv("SENDER_PASSWORD", "")
RECIPIENT_EMAILS = [
    "sondn@vns.ai.vn",
    "huylq@vns.ai.vn",
]

DOWN_SUBJECT = "[CẢNH BÁO] AIBOX mất kết nối - Cảng Gia Vũ - Hải Phòng"
DOWN_BODY_TEMPLATE = """
<html><body style="font-family:Arial,sans-serif;color:#1f2937;">
<h2 style="color:#b91c1c;">AIBOX mất kết nối</h2>
<p><b>Thời gian:</b> {timestamp}</p>
<table style="border-collapse:collapse;width:100%;max-width:760px;">
  <tr style="background:#f3f4f6;"><th style="border:1px solid #ddd;padding:8px;text-align:left;">Trạng thái</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">AIBOX</th><th style="border:1px solid #ddd;padding:8px;text-align:left;">IP</th></tr>
  <tr><td style="border:1px solid #ddd;padding:8px;color:#b91c1c;font-weight:bold;">Mất kết nối</td><td style="border:1px solid #ddd;padding:8px;">{name}</td><td style="border:1px solid #ddd;padding:8px;">{ip}</td></tr>
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
  <tr><td style="border:1px solid #ddd;padding:8px;color:#15803d;font-weight:bold;">Đã kết nối lại</td><td style="border:1px solid #ddd;padding:8px;">{name}</td><td style="border:1px solid #ddd;padding:8px;">{ip}</td></tr>
</table>
</body></html>
"""

LOG_FILE = "aibox_monitor.log"
LOG_LEVEL = "INFO"
