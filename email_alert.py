import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import config

logger = logging.getLogger(__name__)


class EmailAlert:
    def __init__(self):
        self.smtp_server = config.SMTP_SERVER
        self.smtp_port = config.SMTP_PORT
        self.use_tls = config.EMAIL_USE_TLS
        self.sender_email = config.SENDER_EMAIL
        self.sender_password = config.SENDER_PASSWORD

    def send_status_email(self, subject: str, body: str, recipients: list[str]) -> bool:
        if not config.EMAIL_ENABLED:
            logger.info("Email alerts are disabled. Skipping.")
            return False

        if not self.sender_email or not self.sender_password or not recipients:
            logger.error("Email configuration is incomplete. Skipping status email.")
            return False

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = self.sender_email
        msg["To"] = ", ".join(recipients)
        msg.attach(MIMEText(body, "html", "utf-8"))

        try:
            logger.info(f"Connecting to SMTP server {self.smtp_server}:{self.smtp_port}")
            if self.use_tls:
                server = smtplib.SMTP(self.smtp_server, self.smtp_port, timeout=10)
                server.starttls()
            else:
                server = smtplib.SMTP_SSL(self.smtp_server, self.smtp_port, timeout=10)

            try:
                server.login(self.sender_email, self.sender_password)
                server.sendmail(self.sender_email, recipients, msg.as_string())
            finally:
                server.quit()

            logger.info("Status email sent successfully")
            return True
        except smtplib.SMTPAuthenticationError as e:
            logger.error(f"SMTP authentication failed: {e}")
            return False
        except smtplib.SMTPException as e:
            logger.error(f"SMTP error occurred: {e}")
            return False
        except Exception as e:
            logger.error(f"Failed to send status email: {e}")
            return False
