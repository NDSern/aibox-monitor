import json

import config


def _valid_aibox_config():
    return [
        {
            "name": "Site 1",
            "check-devices": True,
            "check-resource": False,
            "local": False,
            "user": "linaro",
            "ip": "192.0.2.10",
            "recipients": ["ops@example.com"],
            "targets": {"192.0.2.20": "Camera 1"},
        }
    ]


def test_get_aiboxes_reads_valid_json(tmp_path, monkeypatch):
    path = tmp_path / "aiboxes.json"
    path.write_text(json.dumps({"192.0.2.1": "Box 1"}), encoding="utf-8")

    monkeypatch.setattr(config, "AIBOXES_FILE", str(path))
    monkeypatch.setattr(config, "_aiboxes_cache", dict(config.DEFAULT_AIBOXES))

    assert config.get_aiboxes() == {"192.0.2.1": "Box 1"}


def test_get_recipient_emails_reads_valid_json(tmp_path, monkeypatch):
    path = tmp_path / "recipients.json"
    path.write_text(json.dumps(["ops@example.com"]), encoding="utf-8")

    monkeypatch.setattr(config, "RECIPIENTS_FILE", str(path))
    monkeypatch.setattr(config, "_recipients_cache", list(config.DEFAULT_RECIPIENT_EMAILS))

    assert config.get_recipient_emails() == ["ops@example.com"]


def test_get_aiboxes_keeps_last_good_on_invalid_json(tmp_path, monkeypatch):
    path = tmp_path / "aiboxes.json"
    path.write_text(json.dumps({"192.0.2.1": "Box 1"}), encoding="utf-8")

    monkeypatch.setattr(config, "AIBOXES_FILE", str(path))
    monkeypatch.setattr(config, "_aiboxes_cache", dict(config.DEFAULT_AIBOXES))

    assert config.get_aiboxes() == {"192.0.2.1": "Box 1"}

    path.write_text('{"192.0.2.2": ', encoding="utf-8")

    assert config.get_aiboxes() == {"192.0.2.1": "Box 1"}


def test_get_recipient_emails_keeps_last_good_on_invalid_schema(tmp_path, monkeypatch):
    path = tmp_path / "recipients.json"
    path.write_text(json.dumps(["ops@example.com"]), encoding="utf-8")

    monkeypatch.setattr(config, "RECIPIENTS_FILE", str(path))
    monkeypatch.setattr(config, "_recipients_cache", list(config.DEFAULT_RECIPIENT_EMAILS))

    assert config.get_recipient_emails() == ["ops@example.com"]

    path.write_text(json.dumps({"email": "bad@example.com"}), encoding="utf-8")

    assert config.get_recipient_emails() == ["ops@example.com"]


def test_config_readers_return_cache_copies(tmp_path, monkeypatch):
    aiboxes_path = tmp_path / "aiboxes.json"
    recipients_path = tmp_path / "recipients.json"
    aiboxes_path.write_text(json.dumps({"192.0.2.1": "Box 1"}), encoding="utf-8")
    recipients_path.write_text(json.dumps(["ops@example.com"]), encoding="utf-8")

    monkeypatch.setattr(config, "AIBOXES_FILE", str(aiboxes_path))
    monkeypatch.setattr(config, "RECIPIENTS_FILE", str(recipients_path))

    aiboxes = config.get_aiboxes()
    recipients = config.get_recipient_emails()
    aiboxes["192.0.2.2"] = "Box 2"
    recipients.append("other@example.com")

    assert config.get_aiboxes() == {"192.0.2.1": "Box 1"}
    assert config.get_recipient_emails() == ["ops@example.com"]


def test_get_aibox_configs_reads_valid_json(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_text(json.dumps(_valid_aibox_config()), encoding="utf-8")

    monkeypatch.setattr(config, "AIBOX_CONFIG_FILE", str(path))
    monkeypatch.setattr(config, "_aibox_config_cache", [])

    assert config.get_aibox_configs() == _valid_aibox_config()


def test_get_aibox_configs_keeps_last_good_on_invalid_json(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_text(json.dumps(_valid_aibox_config()), encoding="utf-8")

    monkeypatch.setattr(config, "AIBOX_CONFIG_FILE", str(path))
    monkeypatch.setattr(config, "_aibox_config_cache", [])

    assert config.get_aibox_configs() == _valid_aibox_config()

    path.write_text(json.dumps([{"name": "bad"}]), encoding="utf-8")

    assert config.get_aibox_configs() == _valid_aibox_config()


def test_get_aibox_configs_returns_cache_copies(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_text(json.dumps(_valid_aibox_config()), encoding="utf-8")

    monkeypatch.setattr(config, "AIBOX_CONFIG_FILE", str(path))

    aibox_configs = config.get_aibox_configs()
    aibox_configs[0]["recipients"].append("other@example.com")
    aibox_configs[0]["targets"]["192.0.2.21"] = "Camera 2"

    assert config.get_aibox_configs() == _valid_aibox_config()


def test_get_aibox_configs_accepts_local_without_user_or_ip(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    local_config = [
        {
            "name": "Local AIBOXes",
            "check-devices": True,
            "local": True,
            "recipients": ["ops@example.com"],
            "targets": {"192.0.2.1": "Box 1"},
        }
    ]
    path.write_text(json.dumps(local_config), encoding="utf-8")

    monkeypatch.setattr(config, "AIBOX_CONFIG_FILE", str(path))
    monkeypatch.setattr(config, "_aibox_config_cache", [])

    assert config.get_aibox_configs() == [
        {
            "name": "Local AIBOXes",
            "check-devices": True,
            "check-resource": False,
            "local": True,
            "user": "",
            "ip": "",
            "recipients": ["ops@example.com"],
            "targets": {"192.0.2.1": "Box 1"},
        }
    ]


def test_get_aibox_configs_rejects_nonlocal_without_user_or_ip(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps(
            [
                {
                    "name": "Remote AIBOX",
                    "check-devices": True,
                    "local": False,
                    "recipients": ["ops@example.com"],
                    "targets": {"192.0.2.20": "Camera 1"},
                }
            ]
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(config, "AIBOX_CONFIG_FILE", str(path))
    monkeypatch.setattr(config, "_aibox_config_cache", [])

    assert config.get_aibox_configs() == []


def test_get_aibox_configs_accepts_resource_only_empty_targets(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps(
            [
                {
                    "name": "Resource Only",
                    "check-resource": True,
                    "local": False,
                    "user": "linaro",
                    "ip": "192.0.2.10",
                    "recipients": ["ops@example.com"],
                    "targets": {},
                }
            ]
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(config, "AIBOX_CONFIG_FILE", str(path))
    monkeypatch.setattr(config, "_aibox_config_cache", [])

    assert config.get_aibox_configs() == [
        {
            "name": "Resource Only",
            "check-devices": False,
            "check-resource": True,
            "local": False,
            "user": "linaro",
            "ip": "192.0.2.10",
            "recipients": ["ops@example.com"],
            "targets": {},
        }
    ]


def test_aibox_config_list_error_identifies_invalid_item():
    error = config._aibox_config_list_error(
        [
            {
                "name": "Bad Remote",
                "check-devices": True,
                "local": False,
                "recipients": ["ops@example.com"],
                "targets": {},
            }
        ]
    )

    assert error == "item 0 (Bad Remote): non-local enabled checks require non-empty user"


def test_v2_config_supports_status_recipient_groups_and_resource_recipients(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps(
            {
                "version": 2,
                "recipient_groups": {
                    "aibox_report": ["status@example.com"],
                    "group2": ["group2@example.com"],
                },
                "default_status_recipient_group": "aibox_report",
                "default_recipients": ["default@example.com"],
                "aiboxes": [
                    {
                        "id": "box-1",
                        "name": "Box 1",
                        "user": "linaro",
                        "ip": "192.0.2.10",
                        "check-devices": True,
                        "check-resource": True,
                        "status_recipient_group": "group2",
                        "resource_recipients": ["resource@example.com"],
                    }
                ],
                "target_scopes": [],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(config, "AIBOX_CONFIG_FILE", str(path))
    monkeypatch.setattr(config, "_aibox_config_cache", [])

    configs = config.get_aibox_configs()

    assert configs[0]["recipient_groups"] == {
        "aibox_report": ["status@example.com"],
        "group2": ["group2@example.com"],
    }
    assert configs[0]["status_recipient_groups"] == {"192.0.2.10": "group2"}
    assert configs[1]["recipients"] == ["resource@example.com"]


def test_v2_config_defaults_status_group_from_legacy_report_recipients(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps(
            {
                "version": 2,
                "aibox_report_recipients": ["status@example.com"],
                "default_recipients": ["default@example.com"],
                "aiboxes": [
                    {
                        "name": "Box 1",
                        "user": "linaro",
                        "ip": "192.0.2.10",
                        "check-devices": True,
                        "check-resource": True,
                    }
                ],
                "target_scopes": [],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(config, "AIBOX_CONFIG_FILE", str(path))
    monkeypatch.setattr(config, "_aibox_config_cache", [])

    configs = config.get_aibox_configs()

    assert configs[0]["recipient_groups"] == {"aibox_report": ["status@example.com"]}
    assert configs[0]["status_recipient_groups"] == {"192.0.2.10": "aibox_report"}
    assert configs[1]["recipients"] == ["default@example.com"]


def test_v2_config_rejects_unknown_status_recipient_group(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps(
            {
                "version": 2,
                "recipient_groups": {"aibox_report": ["status@example.com"]},
                "default_recipients": ["default@example.com"],
                "aiboxes": [
                    {
                        "name": "Box 1",
                        "user": "linaro",
                        "ip": "192.0.2.10",
                        "check-devices": True,
                        "status_recipient_group": "missing",
                    }
                ],
                "target_scopes": [],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(config, "AIBOX_CONFIG_FILE", str(path))
    monkeypatch.setattr(config, "_aibox_config_cache", [])

    assert config.get_aibox_configs() == []


def test_v2_config_preserves_explicit_empty_recipients(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps(
            {
                "version": 2,
                "recipient_groups": {
                    "aibox_report": [],
                    "group2": ["group2@example.com"],
                },
                "default_status_recipient_group": "aibox_report",
                "default_recipients": ["default@example.com"],
                "aiboxes": [
                    {
                        "id": "box-1",
                        "name": "Box 1",
                        "user": "linaro",
                        "ip": "192.0.2.10",
                        "check-devices": True,
                        "check-resource": True,
                        "resource_recipients": [],
                        "networks": ["site-1"],
                    }
                ],
                "target_scopes": [
                    {
                        "id": "site-1",
                        "name": "Site 1",
                        "recipients": [],
                        "targets": {"192.0.2.20": "Camera 1"},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(config, "AIBOX_CONFIG_FILE", str(path))
    monkeypatch.setattr(config, "_aibox_config_cache", [])

    configs = config.get_aibox_configs()

    assert configs[0]["recipient_groups"] == {"aibox_report": [], "group2": ["group2@example.com"]}
    assert configs[0]["recipients"] == []
    assert configs[1]["recipients"] == []
    assert configs[2]["recipients"] == []


def test_v2_config_missing_recipients_still_fall_back_to_defaults(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps(
            {
                "version": 2,
                "recipient_groups": {"aibox_report": ["status@example.com"]},
                "default_recipients": ["default@example.com"],
                "aiboxes": [
                    {
                        "id": "box-1",
                        "name": "Box 1",
                        "user": "linaro",
                        "ip": "192.0.2.10",
                        "check-devices": True,
                        "check-resource": True,
                        "networks": ["site-1"],
                    }
                ],
                "target_scopes": [
                    {
                        "id": "site-1",
                        "name": "Site 1",
                        "targets": {"192.0.2.20": "Camera 1"},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(config, "AIBOX_CONFIG_FILE", str(path))
    monkeypatch.setattr(config, "_aibox_config_cache", [])

    configs = config.get_aibox_configs()

    assert configs[0]["recipients"] == ["status@example.com"]
    assert configs[1]["recipients"] == ["default@example.com"]
    assert configs[2]["recipients"] == ["default@example.com"]
