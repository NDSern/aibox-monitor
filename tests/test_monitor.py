import config
from datetime import datetime
import subprocess
from main import AiboxMonitor


def _target_config():
    return [
        {
            "name": "Site 1",
            "check-devices": True,
            "check-resource": False,
            "local": False,
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
            "check-devices": True,
            "check-resource": False,
            "local": True,
            "user": "",
            "ip": "",
            "recipients": ["ops@example.com"],
            "targets": {"192.0.2.1": "Box 1"},
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


def test_disabled_aibox_is_not_pinged_or_reported(monkeypatch):
    monitor = AiboxMonitor()
    pings = []
    sent = []

    monkeypatch.setattr(
        config,
        "get_aibox_configs",
        lambda: [
            {
                "name": "Box 1",
                "check-devices": False,
                "check-resource": False,
                "local": True,
                "user": "",
                "ip": "",
                "recipients": ["ops@example.com"],
                "targets": {"192.0.2.1": "Box 1"},
            }
        ],
    )
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: pings.append(ip) or True)
    monkeypatch.setattr(monitor, "_send_status_summary_email", lambda *args: sent.append(args))

    monitor.check_aiboxes()

    assert pings == []
    assert sent == []
    assert monitor.aibox_status == {}


def test_offline_transition_sends_batched_status_email(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.1": True}
    sent = []

    monkeypatch.setattr(config, "get_aibox_configs", _direct_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: False)
    monkeypatch.setattr(monitor, "_send_aibox_status_change_email", lambda *args: sent.append(args))

    monitor.check_aiboxes()

    assert len(sent) == 1
    assert sent[0][0]["name"] == "Tất cả AIBOX"
    assert sent[0][2] == {"192.0.2.1": "Mất kết nối"}
    assert monitor.aibox_status == {"192.0.2.1": False}


def test_recovery_transition_sends_batched_status_email(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.1": False}
    sent = []

    monkeypatch.setattr(config, "get_aibox_configs", _direct_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: True)
    monkeypatch.setattr(monitor, "_send_aibox_status_change_email", lambda *args: sent.append(args))

    recovered = monitor.check_aiboxes()

    assert len(sent) == 1
    assert sent[0][0]["name"] == "Tất cả AIBOX"
    assert sent[0][2] == {"192.0.2.1": "Đã kết nối lại"}
    assert recovered == {"192.0.2.1"}
    assert monitor.aibox_status == {"192.0.2.1": True}


def test_unchanged_state_does_not_send_email(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.1": True}
    sent = []

    monkeypatch.setattr(config, "get_aibox_configs", _direct_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: True)
    monkeypatch.setattr(monitor, "_send_aibox_status_change_email", lambda *args: sent.append(args))

    monitor.check_aiboxes()

    assert sent == []
    assert monitor.aibox_status == {"192.0.2.1": True}


def test_multiple_status_changes_send_one_batched_email(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.1": True, "192.0.2.2": False, "192.0.2.3": True}
    sent = []

    monkeypatch.setattr(
        config,
        "get_aibox_configs",
        lambda: [
            {"name": "Local", "check-devices": True, "check-resource": False, "local": True, "user": "", "ip": "", "recipients": ["ops@example.com"], "targets": {"192.0.2.1": "Box 1", "192.0.2.2": "Box 2", "192.0.2.3": "Box 3"}},
        ],
    )
    monkeypatch.setattr(
        monitor,
        "_ping_host",
        lambda ip: {"192.0.2.1": False, "192.0.2.2": True, "192.0.2.3": True}[ip],
    )
    monkeypatch.setattr(monitor, "_send_aibox_status_change_email", lambda *args: sent.append(args))

    monitor.check_aiboxes()

    assert len(sent) == 1
    assert sent[0][2] == {"192.0.2.1": "Mất kết nối", "192.0.2.2": "Đã kết nối lại"}
    assert monitor.aibox_status == {"192.0.2.1": False, "192.0.2.2": True, "192.0.2.3": True}


def test_aibox_status_changes_use_single_existing_recipient_list(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.1": True, "192.0.2.2": True}
    sent = []

    monkeypatch.setattr(
        config,
        "get_aibox_configs",
        lambda: [
            {"name": "Local 1", "check-devices": True, "check-resource": False, "local": True, "user": "", "ip": "", "recipients": ["a@example.com"], "targets": {"192.0.2.1": "Box 1"}},
            {"name": "Local 2", "check-devices": True, "check-resource": False, "local": True, "user": "", "ip": "", "recipients": ["b@example.com"], "targets": {"192.0.2.2": "Box 2"}},
        ],
    )
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: False)
    monkeypatch.setattr(monitor, "_send_aibox_status_change_email", lambda *args: sent.append(args))

    monitor.check_aiboxes()

    assert len(sent) == 1
    assert sent[0][0]["recipients"] == ["a@example.com"]
    assert sent[0][0]["targets"] == {"192.0.2.1": "Box 1", "192.0.2.2": "Box 2"}
    assert sent[0][2] == {"192.0.2.1": "Mất kết nối", "192.0.2.2": "Mất kết nối"}


def test_aibox_status_changes_send_one_email_per_status_group(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.1": True, "192.0.2.2": True, "192.0.2.3": True}
    sent = []

    monkeypatch.setattr(
        config,
        "get_aibox_configs",
        lambda: [
            {
                "name": "Local",
                "check-devices": True,
                "check-resource": False,
                "local": True,
                "user": "",
                "ip": "",
                "recipients": ["fallback@example.com"],
                "targets": {
                    "192.0.2.1": "Box 1",
                    "192.0.2.2": "Box 2",
                    "192.0.2.3": "Box 3",
                },
                "recipient_groups": {
                    "group1": ["g1@example.com"],
                    "group2": ["g2@example.com"],
                },
                "status_recipient_groups": {
                    "192.0.2.1": "group1",
                    "192.0.2.2": "group1",
                    "192.0.2.3": "group2",
                },
            }
        ],
    )
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: False)
    monkeypatch.setattr(monitor, "_send_aibox_status_change_email", lambda *args: sent.append(args))

    monitor.check_aiboxes()

    assert len(sent) == 2
    assert sent[0][0]["recipients"] == ["g1@example.com"]
    assert sent[0][0]["targets"] == {"192.0.2.1": "Box 1", "192.0.2.2": "Box 2"}
    assert sent[0][2] == {"192.0.2.1": "Mất kết nối", "192.0.2.2": "Mất kết nối"}
    assert sent[1][0]["recipients"] == ["g2@example.com"]
    assert sent[1][0]["targets"] == {"192.0.2.3": "Box 3"}
    assert sent[1][2] == {"192.0.2.3": "Mất kết nối"}


def test_aibox_status_groups_skip_partial_v2_metadata(caplog):
    configs = [
        {
            "name": "Local",
            "check-devices": True,
            "check-resource": False,
            "local": True,
            "user": "",
            "ip": "",
            "recipients": ["fallback@example.com"],
            "targets": {"192.0.2.1": "Box 1", "192.0.2.2": "Box 2"},
            "recipient_groups": {"group1": ["g1@example.com"]},
        }
    ]

    assert AiboxMonitor._aibox_status_groups(configs) == {}
    assert "status recipient grouping is incomplete" in caplog.text


def test_aibox_status_groups_skip_missing_target_group(caplog):
    configs = [
        {
            "name": "Local",
            "check-devices": True,
            "check-resource": False,
            "local": True,
            "user": "",
            "ip": "",
            "recipients": ["fallback@example.com"],
            "targets": {"192.0.2.1": "Box 1", "192.0.2.2": "Box 2"},
            "recipient_groups": {"group1": ["g1@example.com"]},
            "status_recipient_groups": {"192.0.2.1": "group1"},
        }
    ]

    assert AiboxMonitor._aibox_status_groups(configs) == {}
    assert "has no status recipient group" in caplog.text


def test_aibox_status_groups_skip_unknown_group(caplog):
    configs = [
        {
            "name": "Local",
            "check-devices": True,
            "check-resource": False,
            "local": True,
            "user": "",
            "ip": "",
            "recipients": ["fallback@example.com"],
            "targets": {"192.0.2.1": "Box 1"},
            "recipient_groups": {"group1": ["g1@example.com"]},
            "status_recipient_groups": {"192.0.2.1": "missing"},
        }
    ]

    assert AiboxMonitor._aibox_status_groups(configs) == {}
    assert "group is undefined: missing" in caplog.text


def _set_now(monkeypatch, value: datetime):
    class FixedDatetime:
        @classmethod
        def now(cls):
            return value

    monkeypatch.setattr("main.datetime", FixedDatetime)


def test_status_summary_sends_at_configured_hour(monkeypatch):
    monitor = AiboxMonitor()
    sent = []

    monkeypatch.setattr(config, "get_aibox_configs", _direct_config)
    _set_now(monkeypatch, datetime(2026, 5, 15, 6, 1, 0))
    monkeypatch.setattr(monitor, "_send_status_summary_email", lambda *args: sent.append(args))

    monitor.send_scheduled_status_summaries()

    assert len(sent) == 1
    assert sent[0][1] == ["ops@example.com"]
    assert sent[0][2] == {"192.0.2.1": "Box 1"}
    assert monitor.last_status_summary_slot == "2026-05-15 06"


def test_status_summary_sends_once_per_slot(monkeypatch):
    monitor = AiboxMonitor()
    sent = []

    monkeypatch.setattr(config, "get_aibox_configs", _direct_config)
    _set_now(monkeypatch, datetime(2026, 5, 15, 12, 30, 0))
    monkeypatch.setattr(monitor, "_send_status_summary_email", lambda *args: sent.append(args))

    monitor.send_scheduled_status_summaries()
    monitor.send_scheduled_status_summaries()

    assert len(sent) == 1


def test_status_summary_uses_single_existing_aibox_recipient_list(monkeypatch):
    monitor = AiboxMonitor()
    sent = []

    monkeypatch.setattr(
        config,
        "get_aibox_configs",
        lambda: [
            {"name": "Local 1", "check-devices": True, "check-resource": False, "local": True, "user": "", "ip": "", "recipients": ["a@example.com"], "targets": {"192.0.2.1": "Box 1"}},
            {"name": "Local 2", "check-devices": True, "check-resource": False, "local": True, "user": "", "ip": "", "recipients": ["b@example.com"], "targets": {"192.0.2.2": "Box 2"}},
        ],
    )
    _set_now(monkeypatch, datetime(2026, 5, 15, 12, 0, 0))
    monkeypatch.setattr(monitor, "_send_status_summary_email", lambda *args: sent.append(args))

    monitor.send_scheduled_status_summaries()

    assert len(sent) == 1
    assert sent[0][1] == ["a@example.com"]
    assert sent[0][2] == {"192.0.2.1": "Box 1", "192.0.2.2": "Box 2"}


def test_status_summary_sends_one_email_per_status_group(monkeypatch):
    monitor = AiboxMonitor()
    sent = []

    monkeypatch.setattr(
        config,
        "get_aibox_configs",
        lambda: [
            {
                "name": "Local",
                "check-devices": True,
                "check-resource": False,
                "local": True,
                "user": "",
                "ip": "",
                "recipients": ["fallback@example.com"],
                "targets": {
                    "192.0.2.1": "Box 1",
                    "192.0.2.2": "Box 2",
                    "192.0.2.3": "Box 3",
                },
                "recipient_groups": {
                    "group1": ["g1@example.com"],
                    "group2": ["g2@example.com"],
                },
                "status_recipient_groups": {
                    "192.0.2.1": "group1",
                    "192.0.2.2": "group1",
                    "192.0.2.3": "group2",
                },
            }
        ],
    )
    _set_now(monkeypatch, datetime(2026, 5, 15, 12, 0, 0))
    monkeypatch.setattr(monitor, "_send_status_summary_email", lambda *args: sent.append(args))

    monitor.send_scheduled_status_summaries()

    assert len(sent) == 2
    assert sent[0][1] == ["g1@example.com"]
    assert sent[0][2] == {"192.0.2.1": "Box 1", "192.0.2.2": "Box 2"}
    assert sent[1][1] == ["g2@example.com"]
    assert sent[1][2] == {"192.0.2.3": "Box 3"}


def test_status_summary_waits_before_configured_hour(monkeypatch):
    monitor = AiboxMonitor()
    sent = []

    monkeypatch.setattr(config, "get_aibox_configs", _direct_config)
    _set_now(monkeypatch, datetime(2026, 5, 15, 7, 0, 0))
    monkeypatch.setattr(monitor, "_send_status_summary_email", lambda *args: sent.append(args))

    monitor.send_scheduled_status_summaries()

    assert sent == []
    assert monitor.last_status_summary_slot is None


def test_status_summary_sends_for_each_scope(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.10": True}
    monitor.target_status = {"192.0.2.10:192.0.2.20": True}
    monitor.resource_status = {"192.0.2.10": {"CPU": 10.0, "RAM": 20.0, "NPU Core 0": 0.0}}
    local_sent = []
    target_sent = []
    resource_sent = []

    monkeypatch.setattr(config, "get_aibox_configs", lambda: _direct_config() + _target_config())
    _set_now(monkeypatch, datetime(2026, 5, 15, 18, 0, 0))
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(monitor, "_send_status_summary_email", lambda *args: local_sent.append(args))
    monkeypatch.setattr(monitor, "_send_target_status_summary_email", lambda *args: target_sent.append(args))
    monkeypatch.setattr(monitor, "_send_resource_status_summary_email", lambda *args: resource_sent.append(args))

    configs = _target_config()
    configs[0]["check-resource"] = True
    monkeypatch.setattr(config, "get_aibox_configs", lambda: _direct_config() + configs)
    monitor.send_scheduled_status_summaries()

    assert len(local_sent) == 1
    assert len(target_sent) == 1
    assert len(resource_sent) == 1


def test_status_summary_skips_offline_or_ssh_unavailable_scopes(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.10": False}
    target_sent = []
    resource_sent = []

    configs = _target_config()
    configs[0]["check-resource"] = True
    monkeypatch.setattr(config, "get_aibox_configs", lambda: configs)
    _set_now(monkeypatch, datetime(2026, 5, 15, 0, 0, 0))
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(monitor, "_send_target_status_summary_email", lambda *args: target_sent.append(args))
    monkeypatch.setattr(monitor, "_send_resource_status_summary_email", lambda *args: resource_sent.append(args))

    monitor.send_scheduled_status_summaries()

    assert target_sent == []
    assert resource_sent == []


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
    assert "Báo cáo tự động lúc 0h, 6h, 12h và 18h" in body
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


def test_check_aibox_targets_skips_disabled_aibox(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.10": True}
    ssh = []

    disabled = _target_config()
    disabled[0]["check-devices"] = False
    monkeypatch.setattr(config, "get_aibox_configs", lambda: disabled)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: ssh.append(args) or True)

    monitor.check_aibox_targets()

    assert ssh == []
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


def test_check_aibox_targets_pings_targets_from_aibox_without_local_precheck(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.10": True}
    ssh_pings = []

    monkeypatch.setattr(config, "get_aibox_configs", _target_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: False)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(monitor, "_ping_target_from_aibox", lambda *args: ssh_pings.append(args) or True)

    monitor.check_aibox_targets()

    assert ssh_pings == [
        ("linaro", "192.0.2.10", "192.0.2.20"),
        ("linaro", "192.0.2.10", "192.0.2.21"),
    ]
    assert monitor.target_status == {
        "192.0.2.10:192.0.2.20": True,
        "192.0.2.10:192.0.2.21": True,
    }


def test_check_aibox_targets_sends_one_batched_transition_email(monkeypatch):
    monitor = AiboxMonitor()
    monitor.target_status = {
        "192.0.2.10:192.0.2.20": True,
        "192.0.2.10:192.0.2.21": False,
    }
    monitor.aibox_status = {"192.0.2.10": True}
    sent = []

    monkeypatch.setattr(config, "get_aibox_configs", _target_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: True)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(
        monitor,
        "_ping_target_from_aibox",
        lambda user, aibox_ip, target_ip: {"192.0.2.20": False, "192.0.2.21": True}[target_ip],
    )
    monkeypatch.setattr(monitor, "_send_target_status_change_email", lambda *args: sent.append(args))

    monitor.check_aibox_targets()

    assert len(sent) == 1
    assert sent[0][2] == {"192.0.2.20": "Mất kết nối", "192.0.2.21": "Đã kết nối lại"}
    assert monitor.target_status == {
        "192.0.2.10:192.0.2.20": False,
        "192.0.2.10:192.0.2.21": True,
    }


def test_check_aibox_targets_sends_recovery_result_without_status_change(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.10": True}
    monitor.target_status = {
        "192.0.2.10:192.0.2.20": True,
        "192.0.2.10:192.0.2.21": True,
    }
    recovery_results = []
    status_changes = []

    monkeypatch.setattr(config, "get_aibox_configs", _target_config)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(monitor, "_ping_target_from_aibox", lambda *args: True)
    monkeypatch.setattr(monitor, "_send_target_recovery_check_result_email", lambda *args: recovery_results.append(args))
    monkeypatch.setattr(monitor, "_send_target_status_change_email", lambda *args: status_changes.append(args))

    monitor.check_aibox_targets(recovered_aibox_ips={"192.0.2.10"})

    assert len(recovery_results) == 1
    assert recovery_results[0][0]["name"] == "Site 1"
    assert recovery_results[0][2] == {}
    assert status_changes == []


def test_check_aibox_targets_recovery_result_replaces_status_change_email(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.10": True}
    monitor.target_status = {
        "192.0.2.10:192.0.2.20": True,
        "192.0.2.10:192.0.2.21": False,
    }
    recovery_results = []
    status_changes = []

    monkeypatch.setattr(config, "get_aibox_configs", _target_config)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(
        monitor,
        "_ping_target_from_aibox",
        lambda user, aibox_ip, target_ip: {"192.0.2.20": False, "192.0.2.21": True}[target_ip],
    )
    monkeypatch.setattr(monitor, "_send_target_recovery_check_result_email", lambda *args: recovery_results.append(args))
    monkeypatch.setattr(monitor, "_send_target_status_change_email", lambda *args: status_changes.append(args))

    monitor.check_aibox_targets(recovered_aibox_ips={"192.0.2.10"})

    assert len(recovery_results) == 1
    assert recovery_results[0][2] == {"192.0.2.20": "Mất kết nối", "192.0.2.21": "Đã kết nối lại"}
    assert status_changes == []


def test_send_target_down_email_uses_monitoring_camera_format(monkeypatch):
    monitor = AiboxMonitor()
    sent = []
    monkeypatch.setattr(monitor.email_alert, "send_status_email", lambda *args: sent.append(args))
    monitor.target_status = {"192.0.2.10:192.0.2.20": False, "192.0.2.10:192.0.2.21": True}

    monitor._send_target_down_email(_target_config()[0], "2026-05-15 10:00:00", {"192.0.2.20": "Mất kết nối"})

    subject, body, recipients = sent[0]
    assert subject == "[CẢNH BÁO] Thiết bị sau khi AIBOX mất kết nối - Site 1"
    assert recipients == ["ops@example.com"]
    assert "font-family:Arial,sans-serif;color:#1f2937" in body
    assert "Tên camera" in body
    assert "Site 1" in body
    assert "Camera 1" in body
    assert "#fef2f2" in body


def test_send_batched_aibox_status_change_email_uses_combined_format(monkeypatch):
    monitor = AiboxMonitor()
    sent = []
    monkeypatch.setattr(monitor.email_alert, "send_status_email", lambda *args: sent.append(args))
    monitor.aibox_status = {"192.0.2.1": False, "192.0.2.2": True}
    aibox = {
        "name": "Local Scope",
        "recipients": ["ops@example.com"],
        "targets": {"192.0.2.1": "Box 1", "192.0.2.2": "Box 2"},
    }

    monitor._send_aibox_status_change_email(
        aibox,
        "2026-05-15 10:00:00",
        {"192.0.2.1": "Mất kết nối", "192.0.2.2": "Đã kết nối lại"},
    )

    subject, body, recipients = sent[0]
    assert subject == "[CẢNH BÁO] Tổng hợp thay đổi trạng thái AIBOX - Local Scope"
    assert recipients == ["ops@example.com"]
    assert "Số thay đổi:</b> 2" in body
    assert "Box 1" in body
    assert "Box 2" in body
    assert "Mất kết nối" in body
    assert "Đã kết nối lại" in body


def test_send_batched_target_status_change_email_uses_combined_format(monkeypatch):
    monitor = AiboxMonitor()
    sent = []
    monkeypatch.setattr(monitor.email_alert, "send_status_email", lambda *args: sent.append(args))
    monitor.target_status = {"192.0.2.10:192.0.2.20": False, "192.0.2.10:192.0.2.21": True}

    monitor._send_target_status_change_email(
        _target_config()[0],
        "2026-05-15 10:00:00",
        {"192.0.2.20": "Mất kết nối", "192.0.2.21": "Đã kết nối lại"},
    )

    subject, body, recipients = sent[0]
    assert subject == "[CẢNH BÁO] Tổng hợp thay đổi các thiết bị ở Site 1"
    assert recipients == ["ops@example.com"]
    assert "Số thay đổi:</b> 2" in body
    assert "Camera 1" in body
    assert "Camera 2" in body
    assert "Mất kết nối" in body
    assert "Đã kết nối lại" in body


def test_send_target_recovery_check_result_email_includes_all_statuses(monkeypatch):
    monitor = AiboxMonitor()
    sent = []
    monkeypatch.setattr(monitor.email_alert, "send_status_email", lambda *args: sent.append(args))
    monitor.target_status = {"192.0.2.10:192.0.2.20": True, "192.0.2.10:192.0.2.21": False}

    monitor._send_target_recovery_check_result_email(
        _target_config()[0],
        "2026-05-15 10:00:00",
        {"192.0.2.21": "Mất kết nối"},
    )

    subject, body, recipients = sent[0]
    assert subject == "[THÔNG TIN] Kết quả kiểm tra thiết bị sau khi AIBOX khôi phục - Site 1"
    assert recipients == ["ops@example.com"]
    assert "Số thiết bị:</b> 2" in body
    assert "Số thay đổi:</b> 1" in body
    assert "Camera 1" in body
    assert "Camera 2" in body
    assert "Đang kết nối" in body
    assert "Mất kết nối" in body


def test_check_aibox_resources_uses_check_resource_not_check_devices(monkeypatch):
    monitor = AiboxMonitor()
    sent = []

    monkeypatch.setattr(
        config,
        "get_aibox_configs",
        lambda: [
            {
                "name": "Site 1",
                "check-devices": False,
                "check-resource": True,
                "local": False,
                "user": "linaro",
                "ip": "192.0.2.10",
                "recipients": ["ops@example.com"],
                "targets": {},
            }
        ],
    )
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: True)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(
        monitor,
        "_collect_resources_from_aibox",
        lambda *args: {"CPU": 91.0, "RAM": 92.0, "NPU Core 0": 0.0, "NPU Core 1": 0.0, "NPU Core 2": 0.0},
    )
    monkeypatch.setattr(monitor, "_send_resource_alert_email", lambda *args: sent.append(args))

    monitor.check_aibox_resources()

    assert len(sent) == 1
    assert sent[0][0]["name"] == "Site 1"
    assert sent[0][3] == {"CPU": 91.0, "RAM": 92.0}


def test_collect_resources_sends_script_over_stdin(monkeypatch):
    calls = []

    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(
            args,
            0,
            stdout='{"CPU": 1.0, "RAM": 2.0, "NPU Core 0": 3.0, "NPU Core 1": 4.0, "NPU Core 2": 5.0}',
            stderr="",
        )

    monkeypatch.setattr("main.subprocess.run", fake_run)

    resources = AiboxMonitor._collect_resources_from_aibox("user", "192.0.2.10")

    args, kwargs = calls[0]
    assert args[-2:] == ["python3", "-"]
    assert "input" in kwargs
    assert "def read_cpu():" in kwargs["input"]
    assert resources == {"CPU": 1.0, "RAM": 2.0, "NPU Core 0": 3.0, "NPU Core 1": 4.0, "NPU Core 2": 5.0}


def test_check_aibox_resources_does_not_email_for_one_resource(monkeypatch):
    monitor = AiboxMonitor()
    sent = []

    monkeypatch.setattr(config, "get_aibox_configs", _target_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: True)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(
        monitor,
        "_collect_resources_from_aibox",
        lambda *args: {"CPU": 91.0, "RAM": 40.0, "NPU Core 0": 0.0, "NPU Core 1": 0.0, "NPU Core 2": 0.0},
    )
    monkeypatch.setattr(monitor, "_send_resource_alert_email", lambda *args: sent.append(args))

    configs = _target_config()
    configs[0]["check-resource"] = True
    monkeypatch.setattr(config, "get_aibox_configs", lambda: configs)

    monitor.check_aibox_resources()

    assert sent == []


def test_send_resource_alert_email_uses_resource_tracker_format(monkeypatch):
    monitor = AiboxMonitor()
    sent = []
    monkeypatch.setattr(monitor.email_alert, "send_status_email", lambda *args: sent.append(args))
    aibox = {
        "name": "Site 1",
        "recipients": ["ops@example.com"],
    }
    resources = {"CPU": 91.0, "RAM": 92.0, "NPU Core 0": 1.0, "NPU Core 1": 2.0, "NPU Core 2": 3.0}

    monitor._send_resource_alert_email(aibox, "2026-05-15 10:00:00", resources, {"CPU": 91.0, "RAM": 92.0})

    subject, body, recipients = sent[0]
    assert subject == "[CẢNH BÁO] Tài nguyên AIBOX vượt ngưỡng - Site 1"
    assert recipients == ["ops@example.com"]
    assert "Cảnh báo tài nguyên AIBOX vượt ngưỡng" in body
    assert "Tài nguyên vượt ngưỡng:</b> CPU, RAM" in body
    assert "AIBOX:</b> Site 1" in body
    assert "Vui lòng kiểm tra ngay." in body
    assert "Vượt ngưỡng" in body
    assert "Bình thường" in body
    assert body.count("#fee2e2") == 2


def test_send_all_email_result_templates(monkeypatch):
    monitor = AiboxMonitor()
    sent = []
    monkeypatch.setattr(monitor.email_alert, "send_status_email", lambda *args: sent.append(args) or True)
    timestamp = "2026-05-21 15:00:00"
    recipients = ["sondn@vns.ai.vn"]
    aibox_targets = {
        "100.64.0.49": "Cảng Gia Vũ - Hải Phòng - Cân 1",
        "100.64.0.92": "Cảng Gia Vũ - Hải Phòng - Cân 2",
        "100.64.0.65": "Cảng Mỹ Xuân A - Vũng Tàu",
    }
    local_scope = {
        "name": "Tất cả AIBOX",
        "recipients": recipients,
        "targets": aibox_targets,
    }
    target_scope = {
        "id": "giavu-lan",
        "name": "Cảng Gia Vũ - Hải Phòng",
        "ip": "100.64.0.49",
        "recipients": recipients,
        "targets": {
            "192.168.1.103": "Cam nhìn băng truyền",
            "192.168.1.34": "Cam nhìn cẩu hành từ tàu",
            "192.168.1.101": "Cam nhìn khoang hàng trên xe",
        },
    }
    resource_scope = {
        "name": "Cảng Gia Vũ - Hải Phòng - Cân 1",
        "recipients": recipients,
    }
    resources = {"CPU": 91.0, "RAM": 92.0, "NPU Core 0": 10.0, "NPU Core 1": 95.0, "NPU Core 2": 0.0}
    over_threshold = {"CPU": 91.0, "RAM": 92.0, "NPU Core 1": 95.0}
    monitor.aibox_status = {"100.64.0.49": False, "100.64.0.92": True, "100.64.0.65": True}
    monitor.target_status = {
        "giavu-lan:192.168.1.103": False,
        "giavu-lan:192.168.1.34": True,
        "giavu-lan:192.168.1.101": True,
    }

    senders = [
        lambda: monitor._send_down_email("100.64.0.49", "Cảng Gia Vũ - Hải Phòng - Cân 1", "Tất cả AIBOX", timestamp, recipients, aibox_targets),
        lambda: monitor._send_up_email("100.64.0.49", "Cảng Gia Vũ - Hải Phòng - Cân 1", "Tất cả AIBOX", timestamp, recipients, aibox_targets),
        lambda: monitor._send_aibox_status_change_email(local_scope, timestamp, {"100.64.0.49": "Mất kết nối", "100.64.0.92": "Đã kết nối lại"}),
        lambda: monitor._send_status_summary_email(timestamp, recipients, aibox_targets),
        lambda: monitor._send_target_down_email(target_scope, timestamp, {"192.168.1.103": "Mất kết nối"}),
        lambda: monitor._send_target_up_email(target_scope, timestamp, {"192.168.1.34": "Đã kết nối lại"}),
        lambda: monitor._send_target_status_change_email(target_scope, timestamp, {"192.168.1.103": "Mất kết nối", "192.168.1.34": "Đã kết nối lại"}),
        lambda: monitor._send_target_recovery_check_result_email(target_scope, timestamp, {"192.168.1.103": "Mất kết nối", "192.168.1.34": "Đã kết nối lại"}),
        lambda: monitor._send_target_status_summary_email(target_scope, timestamp),
        lambda: monitor._send_resource_alert_email(resource_scope, timestamp, resources, over_threshold),
        lambda: monitor._send_resource_status_summary_email(resource_scope, timestamp, resources),
    ]

    for send in senders:
        send()

    assert len(sent) == 11
    subjects = [subject for subject, _, _ in sent]
    bodies = "\n".join(body for _, body, _ in sent)
    assert config.DOWN_SUBJECT in subjects
    assert config.UP_SUBJECT in subjects
    assert config.STATUS_SUMMARY_SUBJECT in subjects
    assert "[CẢNH BÁO] Tổng hợp thay đổi trạng thái AIBOX - Tất cả AIBOX" in subjects
    assert "[CẢNH BÁO] Tổng hợp thay đổi các thiết bị ở Cảng Gia Vũ - Hải Phòng" in subjects
    assert "[THÔNG TIN] Kết quả kiểm tra thiết bị sau khi AIBOX khôi phục - Cảng Gia Vũ - Hải Phòng" in subjects
    assert "[BÁO CÁO] Trạng thái thiết bị sau AIBOX hiện tại - Cảng Gia Vũ - Hải Phòng" in subjects
    assert "[CẢNH BÁO] Tài nguyên AIBOX vượt ngưỡng - Cảng Gia Vũ - Hải Phòng - Cân 1" in subjects
    assert "[BÁO CÁO] Tài nguyên AIBOX hiện tại - Cảng Gia Vũ - Hải Phòng - Cân 1" in subjects
    assert all(recipients == ["sondn@vns.ai.vn"] for _, _, recipients in sent)
    assert "Mất kết nối" in bodies
    assert "Đã kết nối lại" in bodies
    assert "Đang kết nối" in bodies
    assert "Vượt ngưỡng" in bodies
    assert "Bình thường" in bodies
