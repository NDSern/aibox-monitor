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
        self.recipients = config.RECIPIENT_EMAILS

    def send_status_email(self, subject: str, body: str) -> bool:
        if not config.EMAIL_ENABLED:
            logger.info("Email alerts are disabled. Skipping.")
            return False

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = self.sender_email
        msg["To"] = ", ".join(self.recipients)
        msg.attach(MIMEText(body, "html", "utf-8"))

        try:
            logger.info(f"Connecting to SMTP server {self.smtp_server}:{self.smtp_port}")
            if self.use_tls:
                server = smtplib.SMTP(self.smtp_server, self.smtp_port)
                server.starttls()
            else:
                server = smtplib.SMTP_SSL(self.smtp_server, self.smtp_port)

            server.login(self.sender_email, self.sender_password)
            server.sendmail(self.sender_email, self.recipients, msg.as_string())
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
