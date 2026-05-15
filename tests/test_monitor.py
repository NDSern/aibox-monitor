import config
from main import AiboxMonitor


def test_initial_state_does_not_send_email(monkeypatch):
    monitor = AiboxMonitor()
    sent = []

    monkeypatch.setattr(config, "get_aiboxes", lambda: {"192.0.2.1": "Box 1"})
    monkeypatch.setattr(config, "get_recipient_emails", lambda: ["ops@example.com"])
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: False)
    monkeypatch.setattr(monitor, "_send_down_email", lambda *args: sent.append(args))

    monitor.check_aiboxes()

    assert sent == []
    assert monitor.aibox_status == {"192.0.2.1": False}


def test_offline_transition_sends_down_email(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.1": True}
    sent = []

    monkeypatch.setattr(config, "get_aiboxes", lambda: {"192.0.2.1": "Box 1"})
    monkeypatch.setattr(config, "get_recipient_emails", lambda: ["ops@example.com"])
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: False)
    monkeypatch.setattr(monitor, "_send_down_email", lambda *args: sent.append(args))

    monitor.check_aiboxes()

    assert len(sent) == 1
    assert sent[0][0:2] == ("192.0.2.1", "Box 1")
    assert sent[0][4] == ["ops@example.com"]
    assert monitor.aibox_status == {"192.0.2.1": False}


def test_recovery_transition_sends_up_email(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.1": False}
    sent = []

    monkeypatch.setattr(config, "get_aiboxes", lambda: {"192.0.2.1": "Box 1"})
    monkeypatch.setattr(config, "get_recipient_emails", lambda: ["ops@example.com"])
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: True)
    monkeypatch.setattr(monitor, "_send_up_email", lambda *args: sent.append(args))

    monitor.check_aiboxes()

    assert len(sent) == 1
    assert sent[0][0:2] == ("192.0.2.1", "Box 1")
    assert sent[0][4] == ["ops@example.com"]
    assert monitor.aibox_status == {"192.0.2.1": True}


def test_unchanged_state_does_not_send_email(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.1": True}
    sent = []

    monkeypatch.setattr(config, "get_aiboxes", lambda: {"192.0.2.1": "Box 1"})
    monkeypatch.setattr(config, "get_recipient_emails", lambda: ["ops@example.com"])
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: True)
    monkeypatch.setattr(monitor, "_send_down_email", lambda *args: sent.append(args))
    monkeypatch.setattr(monitor, "_send_up_email", lambda *args: sent.append(args))

    monitor.check_aiboxes()

    assert sent == []
    assert monitor.aibox_status == {"192.0.2.1": True}
