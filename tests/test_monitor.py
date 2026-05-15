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
    assert sent[0][5] == {"192.0.2.1": "Box 1"}
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
    assert sent[0][5] == {"192.0.2.1": "Box 1"}
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


def test_build_aibox_rows_includes_all_boxes_and_highlights_changed():
    rows = AiboxMonitor._build_aibox_rows(
        {
            "192.0.2.1": "Changed <Box>",
            "192.0.2.2": "Other Box",
        },
        "192.0.2.1",
        "Mất kết nối",
        "#fee2e2",
        "#b91c1c",
    )

    assert "Changed &lt;Box&gt;" in rows
    assert "Other Box" in rows
    assert rows.count("#fee2e2") == 3
    assert "Không thay đổi" in rows


def test_send_down_email_uses_real_template_with_aibox_list(monkeypatch):
    monitor = AiboxMonitor()
    sent = []
    monkeypatch.setattr(monitor.email_alert, "send_status_email", lambda *args: sent.append(args))

    monitor._send_down_email(
        "192.0.2.1",
        "Box 1",
        "host",
        "2026-05-15 10:00:00",
        ["ops@example.com"],
        {"192.0.2.1": "Box 1", "192.0.2.2": "Box 2"},
    )

    subject, body, recipients = sent[0]
    assert subject == config.DOWN_SUBJECT
    assert recipients == ["ops@example.com"]
    assert "Box 1" in body
    assert "Box 2" in body
    assert "#fee2e2" in body
