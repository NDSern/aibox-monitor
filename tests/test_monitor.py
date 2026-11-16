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
            "targets": {"192.0.2.1": "Box 1"},
        }
    ]


def test_initial_state_records_status_without_alerting(monkeypatch):
    monitor = AiboxMonitor()

    monkeypatch.setattr(config, "get_aibox_configs", _direct_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: False)

    monitor.check_aiboxes()

    assert monitor.aibox_status == {"192.0.2.1": False}


def test_offline_transition_updates_status(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.1": True}

    monkeypatch.setattr(config, "get_aibox_configs", _direct_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: False)

    monitor.check_aiboxes()

    assert monitor.aibox_status == {"192.0.2.1": False}


def test_recovery_transition_updates_status(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.1": False}

    monkeypatch.setattr(config, "get_aibox_configs", _direct_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: True)

    monitor.check_aiboxes()

    assert monitor.aibox_status == {"192.0.2.1": True}


def test_multiple_status_changes_are_all_recorded(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.1": True, "192.0.2.2": False, "192.0.2.3": True}
    states = {"192.0.2.1": False, "192.0.2.2": True, "192.0.2.3": True}

    monkeypatch.setattr(
        config,
        "get_aibox_configs",
        lambda: [
            {
                "name": "Box group",
                "check-devices": True,
                "check-resource": False,
                "local": True,
                "user": "",
                "ip": "",
                "targets": {"192.0.2.1": "Box 1", "192.0.2.2": "Box 2", "192.0.2.3": "Box 3"},
            }
        ],
    )
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: states[ip])

    monitor.check_aiboxes()

    assert monitor.aibox_status == states


def test_disabled_aibox_is_not_pinged_or_reported(monkeypatch):
    monitor = AiboxMonitor()
    pings = []

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
                "targets": {"192.0.2.1": "Box 1"},
            }
        ],
    )
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: pings.append(ip) or True)

    monitor.check_aiboxes()

    assert pings == []
    assert monitor.aibox_status == {}


def test_unchanged_state_keeps_previous_status(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.1": True}

    monkeypatch.setattr(config, "get_aibox_configs", _direct_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: True)

    monitor.check_aiboxes()

    assert monitor.aibox_status == {"192.0.2.1": True}


def _set_now(monkeypatch, value: datetime):
    class FixedDatetime:
        @classmethod
        def now(cls):
            return value

    monkeypatch.setattr("main.datetime", FixedDatetime)


def test_check_aibox_targets_skips_when_parent_offline(monkeypatch):
    monitor = AiboxMonitor()

    monkeypatch.setattr(config, "get_aibox_configs", _target_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: False)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(monitor, "_ping_target_from_aibox", lambda *args: True)

    monitor.check_aibox_targets()

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

    monkeypatch.setattr(config, "get_aibox_configs", _target_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: True)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: False)
    monkeypatch.setattr(monitor, "_ping_target_from_aibox", lambda *args: True)

    monitor.check_aibox_targets()

    assert monitor.target_status == {}


def test_unknown_target_preserves_last_known_status(monkeypatch):
    monitor = AiboxMonitor()
    monitor.target_status = {"192.0.2.10:192.0.2.20": False}
    monitor.target_last_known_status = dict(monitor.target_status)
    monitor.aibox_status = {"192.0.2.10": True}
    target_config = _target_config()
    target_config[0]["checkers"] = [{"name": "Box 1", "user": "linaro", "ip": "192.0.2.10"}]

    monkeypatch.setattr(config, "get_aibox_configs", lambda: target_config)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: False)

    monitor.check_aibox_targets()

    assert monitor.target_status["192.0.2.10:192.0.2.20"] is False
    assert "192.0.2.10:192.0.2.20" in monitor.unknown_target_status


def test_unknown_then_offline_is_still_reported_as_a_transition(monkeypatch):
    monitor = AiboxMonitor()
    key = "192.0.2.10:192.0.2.20"
    monitor.target_status[key] = True
    monitor.target_last_known_status[key] = True
    monitor.unknown_target_status.add(key)
    monitor.aibox_status = {"192.0.2.10": True}

    monkeypatch.setattr(config, "get_aibox_configs", _target_config)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(monitor, "_ping_target_from_aibox", lambda user, box_ip, ip: ip == "192.0.2.21")

    monitor.check_aibox_targets()

    assert key not in monitor.unknown_target_status


def test_non_profile_targets_use_ping(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.10": True}
    target_config = _target_config()
    target_config[0]["checkers"] = [{"name": "Box 1", "user": "linaro", "ip": "192.0.2.10"}]
    probes = []
    pings = []

    monkeypatch.setattr(config, "get_aibox_configs", lambda: target_config)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(monitor, "_probe_camera_from_aibox", lambda user, box_ip, ip: probes.append(ip) or {"status": "online", "method": "image"})
    monkeypatch.setattr(monitor, "_ping_target_from_aibox", lambda user, box_ip, ip: pings.append(ip) or True)

    monitor.check_aibox_targets()

    assert probes == []
    assert pings == ["192.0.2.20", "192.0.2.21"]


def test_configured_camera_probe_can_fall_back_to_ping(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"100.64.0.114": True}
    target_config = _target_config()
    target_config[0]["checkers"] = [{"name": "Kim Hoa", "user": "camera", "ip": "100.64.0.114"}]
    target_config[0]["targets"] = {"192.168.1.123": "Camera"}
    pings = []
    monkeypatch.setattr(config, "get_aibox_configs", lambda: target_config)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(monitor, "_probe_camera_from_aibox", lambda *args: {"status": "fallback", "method": "unsupported"})
    monkeypatch.setattr(monitor, "_ping_target_from_aibox", lambda user, box_ip, ip: pings.append(ip) or True)
    monitor.check_aibox_targets()
    assert pings == ["192.168.1.123"]
    assert monitor.target_status["192.0.2.10:192.168.1.123"] is True


def test_image_camera_owner_is_scope_limited_and_zero_checks_unknown(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"100.64.0.114": False}
    target_config = _target_config()
    target_config[0].update({"id": "kimhoa", "checkers": [{"name": "Camera AIBOX", "user": "camera", "ip": "100.64.0.114"}], "targets": {"192.168.1.123": "Camera"}})
    monkeypatch.setattr(config, "get_aibox_configs", lambda: target_config)
    monitor.check_aibox_targets()
    # The owning checker is offline, so the camera is recorded as unknown
    # rather than reported online or offline from a different AIBOX.
    assert "kimhoa:192.168.1.123" in monitor.unknown_target_status
    assert "kimhoa:192.168.1.123" not in monitor.target_status

    # Same private camera address on a different scope remains ordinary ping fallback.
    target_config[0]["id"] = "other-scope"
    monitor.aibox_status["192.0.2.10"] = True
    calls = []
    monkeypatch.setattr(monitor, "_select_target_checker", lambda *_: {"ip": "192.0.2.10", "user": "linaro"})
    monkeypatch.setattr(monitor, "_ping_target_from_aibox", lambda *args: calls.append(args) or True)
    monitor.check_aibox_targets()
    assert len(calls) == 1


def test_camera_probe_partial_frames_preserved_and_missing_tool_falls_back(monkeypatch):
    from main import AiboxMonitor
    import json

    class Result:
        returncode = 0
        stdout = json.dumps({"method": "image", "status": "online", "frames": 3, "valid_frames": 1})

    monkeypatch.setattr("main.subprocess.run", lambda *args, **kwargs: Result())
    assert AiboxMonitor._probe_camera_from_aibox("camera", "100.64.0.114", "192.168.1.123")["valid_frames"] == 1

    class ErrorResult:
        returncode = 0
        stdout = "[]"

    monkeypatch.setattr("main.subprocess.run", lambda *args, **kwargs: ErrorResult())
    assert AiboxMonitor._probe_camera_from_aibox("camera", "100.64.0.114", "192.168.1.123")["status"] == "fallback"


def test_check_aibox_targets_skips_when_target_route_uses_wrong_interface(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.10": True}
    target_config = _target_config()
    target_config[0]["target-interface"] = "eth0"
    pings = []

    monkeypatch.setattr(config, "get_aibox_configs", lambda: target_config)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(monitor, "_target_route_interface", lambda *args: "usb0")
    monkeypatch.setattr(monitor, "_ping_target_from_aibox", lambda *args: pings.append(args) or True)

    monitor.check_aibox_targets()

    assert pings == []
    assert monitor.target_status == {}


def test_target_checker_tries_next_checker_after_route_mismatch(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.10": True, "192.0.2.11": True}
    target_config = _target_config()[0]
    target_config["checkers"] = [
        {"name": "Box 1", "user": "linaro", "ip": "192.0.2.10", "target-interface": "eth0"},
        {"name": "Box 2", "user": "linaro", "ip": "192.0.2.11", "target-interface": "eth0"},
    ]

    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(
        monitor,
        "_target_route_interface",
        lambda user, aibox_ip, target_ip: {"192.0.2.10": "usb0", "192.0.2.11": "eth0"}[aibox_ip],
    )

    assert monitor._select_target_checker(target_config)["ip"] == "192.0.2.11"


def test_target_route_interface_reads_json_route(monkeypatch):
    monitor = AiboxMonitor()

    class Result:
        returncode = 0
        stdout = '[{"dst":"192.0.2.20","dev":"eth0","prefsrc":"192.0.2.10"}]'

    monkeypatch.setattr("main.subprocess.run", lambda *args, **kwargs: Result())

    assert monitor._target_route_interface("linaro", "192.0.2.10", "192.0.2.20") == "eth0"


def test_ssh_commands_reuse_one_connection(monkeypatch):
    monitor = AiboxMonitor()
    commands = []

    class Result:
        returncode = 0
        stdout = ""
        stderr = ""

    monkeypatch.setattr("main.subprocess.run", lambda command, **kwargs: commands.append(command) or Result())

    assert monitor._can_ssh("linaro", "192.0.2.10")
    assert monitor._ping_target_from_aibox("linaro", "192.0.2.10", "192.0.2.20")

    for command in commands:
        assert "ControlMaster=auto" in command
        assert "ControlPath=/tmp/aibox-monitor-ssh-%C" in command
        assert "ControlPersist=5m" in command


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


def test_check_aibox_resources_uses_check_resource_not_check_devices(monkeypatch):
    monitor = AiboxMonitor()

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

    monitor.check_aibox_resources()


def test_check_aibox_resources_reuses_connectivity_status(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"192.0.2.10": True}
    pings = []
    collected = []
    configs = _target_config()
    configs[0]["check-resource"] = True

    monkeypatch.setattr(config, "get_aibox_configs", lambda: configs)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: pings.append(ip) or True)
    monkeypatch.setattr(
        monitor,
        "_collect_resources_from_aibox",
        lambda *args: collected.append(args) or {"CPU": 1.0, "RAM": 2.0},
    )

    monitor.check_aibox_resources()

    assert pings == []
    assert collected == [("linaro", "192.0.2.10")]


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


def test_check_aibox_resources_skips_single_resource(monkeypatch):
    monitor = AiboxMonitor()

    monkeypatch.setattr(config, "get_aibox_configs", _target_config)
    monkeypatch.setattr(monitor, "_ping_host", lambda ip: True)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(
        monitor,
        "_collect_resources_from_aibox",
        lambda *args: {"CPU": 91.0, "RAM": 40.0, "NPU Core 0": 0.0, "NPU Core 1": 0.0, "NPU Core 2": 0.0},
    )

    configs = _target_config()
    configs[0]["check-resource"] = True
    monkeypatch.setattr(config, "get_aibox_configs", lambda: configs)

    monitor.check_aibox_resources()


def test_image_camera_falls_back_to_next_owner(monkeypatch):
    monitor = AiboxMonitor()
    monitor.aibox_status = {"100.64.0.116": False, "100.64.0.36": True, "100.64.0.65": True}
    target_config = _target_config()
    target_config[0].update({"id": "myxuan-lan", "targets": {"192.168.2.55": "Camera"}, "checkers": [
        {"name": "A1", "user": "a1", "ip": "100.64.0.65"},
        {"name": "A2", "user": "a2", "ip": "100.64.0.116"},
        {"name": "A3", "user": "a3", "ip": "100.64.0.36"},
    ]})
    probes = []
    monkeypatch.setattr(config, "get_aibox_configs", lambda: target_config)
    monkeypatch.setattr(monitor, "_can_ssh", lambda *args: True)
    monkeypatch.setattr(monitor, "_probe_camera_from_aibox", lambda user, box_ip, ip: probes.append(box_ip) or {"status": "online", "method": "image", "frames": 10, "valid_frames": 10})
    monitor.check_aibox_targets()
    assert probes == ["100.64.0.36"]
