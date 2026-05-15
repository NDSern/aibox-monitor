import smtplib

import config
from email_alert import EmailAlert


def test_send_status_email_skips_incomplete_config(monkeypatch):
    monkeypatch.setattr(config, "EMAIL_ENABLED", True)
    monkeypatch.setattr(config, "SENDER_EMAIL", "")
    monkeypatch.setattr(config, "SENDER_PASSWORD", "")

    alert = EmailAlert()

    assert alert.send_status_email("subject", "<p>body</p>", ["ops@example.com"]) is False


def test_send_status_email_quits_server_on_send_failure(monkeypatch):
    events = []

    class FakeSMTP:
        def __init__(self, server, port, timeout):
            events.append(("connect", server, port, timeout))

        def starttls(self):
            events.append(("starttls",))

        def login(self, sender, password):
            events.append(("login", sender, password))

        def sendmail(self, sender, recipients, message):
            events.append(("sendmail", sender, tuple(recipients)))
            raise smtplib.SMTPException("send failed")

        def quit(self):
            events.append(("quit",))

    monkeypatch.setattr(config, "EMAIL_ENABLED", True)
    monkeypatch.setattr(config, "EMAIL_USE_TLS", True)
    monkeypatch.setattr(config, "SMTP_SERVER", "smtp.example.com")
    monkeypatch.setattr(config, "SMTP_PORT", 587)
    monkeypatch.setattr(config, "SENDER_EMAIL", "sender@example.com")
    monkeypatch.setattr(config, "SENDER_PASSWORD", "secret")
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)

    alert = EmailAlert()

    assert alert.send_status_email("subject", "<p>body</p>", ["ops@example.com"]) is False
    assert events[-1] == ("quit",)
