import config
from main import AiboxMonitor


def _target_config():
    return [
        {
            "name": "Site 1",
            "user": "linaro",
            "ip": "192.0.2.10",
            "recipients": ["ops@example.com"],
            "targets": {"192.0.2.20": "Camera 1", "192.0.2.21": "Camera 2"},
        }
    ]


def _direct_config():
    return [
        {
            "name": "Box 1",
            "user": "linaro",
            "ip": "192.0.2.1",
            "recipients": ["ops@example.com"],
            "targets": {"192.0.2.20": "Camera 1"},
        }
    ]


def test_initial_state_does_not_send_email(monkeypatch):
    monitor = AiboxMonitor()
    sent = []

    monkeypatch.setattr(config, "get_aibox_configs", _direct_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: False)
    monkeypatch.setattr(monitor, "_send_down_email", lambda *args: sent.append(args))

    monitor.check_aiboxes()

    assert sent == []
    assert monitor.aibox_status == {"192.0.2.1": False}


def test_offline_transition_sends_down_email(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.1": True}
    sent = []

    monkeypatch.setattr(config, "get_aibox_configs", _direct_config)
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

    monkeypatch.setattr(config, "get_aibox_configs", _direct_config)
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

    monkeypatch.setattr(config, "get_aibox_configs", _direct_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: True)
    monkeypatch.setattr(monitor, "_send_down_email", lambda *args: sent.append(args))
    monkeypatch.setattr(monitor, "_send_up_email", lambda *args: sent.append(args))

    monitor.check_aiboxes()

    assert sent == []
    assert monitor.aibox_status == {"192.0.2.1": True}


def test_multiple_status_changes_send_multiple_emails(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.1": True, "192.0.2.2": False, "192.0.2.3": True}
    sent = []

    monkeypatch.setattr(
        config,
        "get_aibox_configs",
        lambda: [
            {"name": "Box 1", "user": "u", "ip": "192.0.2.1", "recipients": ["ops@example.com"], "targets": {"192.0.2.20": "Camera"}},
            {"name": "Box 2", "user": "u", "ip": "192.0.2.2", "recipients": ["ops@example.com"], "targets": {"192.0.2.21": "Camera"}},
            {"name": "Box 3", "user": "u", "ip": "192.0.2.3", "recipients": ["ops@example.com"], "targets": {"192.0.2.22": "Camera"}},
        ],
    )
    monkeypatch.setattr(
        monitor,
        "_ping_host",
        lambda ip: {"192.0.2.1": False, "192.0.2.2": True, "192.0.2.3": True}[ip],
    )
    monkeypatch.setattr(monitor, "_send_down_email", lambda *args: sent.append(("down", args)))
    monkeypatch.setattr(monitor, "_send_up_email", lambda *args: sent.append(("up", args)))

    monitor.check_aiboxes()

    assert [kind for kind, _ in sent] == ["down", "up"]
    assert monitor.aibox_status == {"192.0.2.1": False, "192.0.2.2": True, "192.0.2.3": True}


def test_status_summary_sends_after_interval(monkeypatch):
    monitor = AiboxMonitor()
    monitor.next_status_summary_at = 100.0
    sent = []

    monkeypatch.setattr(config, "get_aibox_configs", _direct_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: True)
    monkeypatch.setattr("main.time.monotonic", lambda: 100.0)
    monkeypatch.setattr(monitor, "_send_status_summary_email", lambda *args: sent.append(args))

    monitor.check_aiboxes()

    assert len(sent) == 1
    assert sent[0][1] == ["ops@example.com"]
    assert sent[0][2] == {"192.0.2.1": "Box 1"}
    assert monitor.next_status_summary_at == 100.0 + config.STATUS_SUMMARY_INTERVAL_SECONDS


def test_status_summary_waits_before_interval(monkeypatch):
    monitor = AiboxMonitor()
    monitor.next_status_summary_at = 101.0
    sent = []

    monkeypatch.setattr(config, "get_aibox_configs", _direct_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: True)
    monkeypatch.setattr("main.time.monotonic", lambda: 100.0)
    monkeypatch.setattr(monitor, "_send_status_summary_email", lambda *args: sent.append(args))

    monitor.check_aiboxes()

    assert sent == []
    assert monitor.next_status_summary_at == 101.0


def test_build_aibox_rows_includes_all_boxes_and_highlights_changed():
    rows = AiboxMonitor._build_aibox_rows(
        {"192.0.2.1": "Changed <Box>", "192.0.2.2": "Other Box"},
        {"192.0.2.2": True},
        {"192.0.2.1": "Mất kết nối"},
    )

    assert "Changed &lt;Box&gt;" in rows
    assert "Other Box" in rows
    assert rows.count("#fee2e2") == 3
    assert "Đang kết nối" in rows
    assert "#15803d" in rows


def test_build_aibox_rows_uses_unknown_for_unrecorded_status():
    rows = AiboxMonitor._build_aibox_rows(
        {"192.0.2.1": "Changed Box", "192.0.2.2": "New Box"},
        {},
        {"192.0.2.1": "Đã kết nối lại"},
    )

    assert "Chưa ghi nhận" in rows
    assert "#6b7280" in rows


def test_send_down_email_uses_real_template_with_aibox_list(monkeypatch):
    monitor = AiboxMonitor()
    sent = []
    monkeypatch.setattr(monitor.email_alert, "send_status_email", lambda *args: sent.append(args))
    monitor.aibox_status = {"192.0.2.1": False, "192.0.2.2": True}

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


def test_send_status_summary_email_uses_real_template(monkeypatch):
    monitor = AiboxMonitor()
    sent = []
    monkeypatch.setattr(monitor.email_alert, "send_status_email", lambda *args: sent.append(args))
    monitor.aibox_status = {"192.0.2.1": True, "192.0.2.2": False}

    monitor._send_status_summary_email(
        "2026-05-15 10:00:00",
        ["ops@example.com"],
        {"192.0.2.1": "Box 1", "192.0.2.2": "Box 2"},
    )

    subject, body, recipients = sent[0]
    assert subject == config.STATUS_SUMMARY_SUBJECT
    assert recipients == ["ops@example.com"]
    assert "Báo cáo tự động sau mỗi 6 giờ" in body
    assert "Box 1" in body
    assert "Box 2" in body
    assert "Đang kết nối" in body
    assert "Mất kết nối" in body


def test_check_aibox_targets_skips_when_parent_offline(monkeypatch):
    monitor = AiboxMonitor()
    sent = []

    monkeypatch.setattr(config, "get_aibox_configs", _target_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: False)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(monitor, "_ping_target_from_aibox", lambda *args: True)
    monkeypatch.setattr(monitor, "_send_target_down_email", lambda *args: sent.append(args))

    monitor.check_aibox_targets()

    assert sent == []
    assert monitor.target_status == {}


def test_check_aibox_targets_skips_when_ssh_unavailable(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.10": True}
    sent = []

    monkeypatch.setattr(config, "get_aibox_configs", _target_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: True)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: False)
    monkeypatch.setattr(monitor, "_ping_target_from_aibox", lambda *args: True)
    monkeypatch.setattr(monitor, "_send_target_down_email", lambda *args: sent.append(args))

    monitor.check_aibox_targets()

    assert sent == []
    assert monitor.target_status == {}


def test_check_aibox_targets_skips_ssh_when_target_not_locally_pingable(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.10": True}
    ssh_pings = []

    monkeypatch.setattr(config, "get_aibox_configs", _target_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: ip == "192.0.2.10")
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(monitor, "_ping_target_from_aibox", lambda *args: ssh_pings.append(args) or True)

    monitor.check_aibox_targets()

    assert ssh_pings == []
    assert monitor.target_status == {}


def test_check_aibox_targets_sends_transition_emails(monkeypatch):
    monitor = AiboxMonitor()
    monitor.target_status = {
        "192.0.2.10:192.0.2.20": True,
        "192.0.2.10:192.0.2.21": False,
    }
    monitor.aibox_status = {"192.0.2.10": True}
    down = []
    up = []

    monkeypatch.setattr(config, "get_aibox_configs", _target_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: True)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(
        monitor,
        "_ping_target_from_aibox",
        lambda user, aibox_ip, target_ip: {"192.0.2.20": False, "192.0.2.21": True}[target_ip],
    )
    monkeypatch.setattr(monitor, "_send_target_down_email", lambda *args: down.append(args))
    monkeypatch.setattr(monitor, "_send_target_up_email", lambda *args: up.append(args))

    monitor.check_aibox_targets()

    assert down[0][2] == {"192.0.2.20": "Mất kết nối"}
    assert up[0][2] == {"192.0.2.21": "Đã kết nối lại"}
    assert monitor.target_status == {
        "192.0.2.10:192.0.2.20": False,
        "192.0.2.10:192.0.2.21": True,
    }


def test_send_target_down_email_uses_monitoring_camera_format(monkeypatch):
    monitor = AiboxMonitor()
    sent = []
    monkeypatch.setattr(monitor.email_alert, "send_status_email", lambda *args: sent.append(args))
    monitor.target_status = {"192.0.2.10:192.0.2.20": False, "192.0.2.10:192.0.2.21": True}

    monitor._send_target_down_email(_target_config()[0], "2026-05-15 10:00:00", {"192.0.2.20": "Mất kết nối"})

    subject, body, recipients = sent[0]
    assert subject == "[CẢNH BÁO] Thiết bị sau AIBOX mất kết nối - Site 1"
    assert recipients == ["ops@example.com"]
    assert "font-family:Arial,sans-serif;color:#1f2937" in body
    assert "Tên camera" in body
    assert "Site 1" in body
    assert "Camera 1" in body
    assert "#fef2f2" in body
