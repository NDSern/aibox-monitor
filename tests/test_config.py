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
            "targets": {"192.0.2.20": "Camera 1"},
        }
    ]


def test_get_aiboxes_reads_valid_json(tmp_path, monkeypatch):
    path = tmp_path / "aiboxes.json"
    path.write_text(json.dumps({"192.0.2.1": "Box 1"}), encoding="utf-8")

    monkeypatch.setattr(config, "AIBOXES_FILE", str(path))
    monkeypatch.setattr(config, "_aiboxes_cache", dict(config.DEFAULT_AIBOXES))

    assert config.get_aiboxes() == {"192.0.2.1": "Box 1"}


def test_get_aiboxes_keeps_last_good_on_invalid_json(tmp_path, monkeypatch):
    path = tmp_path / "aiboxes.json"
    path.write_text(json.dumps({"192.0.2.1": "Box 1"}), encoding="utf-8")

    monkeypatch.setattr(config, "AIBOXES_FILE", str(path))
    monkeypatch.setattr(config, "_aiboxes_cache", dict(config.DEFAULT_AIBOXES))

    assert config.get_aiboxes() == {"192.0.2.1": "Box 1"}

    path.write_text('{"192.0.2.2": ', encoding="utf-8")

    assert config.get_aiboxes() == {"192.0.2.1": "Box 1"}


def test_config_readers_return_cache_copies(tmp_path, monkeypatch):
    aiboxes_path = tmp_path / "aiboxes.json"
    aiboxes_path.write_text(json.dumps({"192.0.2.1": "Box 1"}), encoding="utf-8")

    monkeypatch.setattr(config, "AIBOXES_FILE", str(aiboxes_path))

    aiboxes = config.get_aiboxes()
    aiboxes["192.0.2.2"] = "Box 2"

    assert config.get_aiboxes() == {"192.0.2.1": "Box 1"}


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

    path.write_text(json.dumps([{"name": "bad", "check-devices": True, "local": False}]), encoding="utf-8")

    assert config.get_aibox_configs() == _valid_aibox_config()


def test_get_aibox_configs_returns_cache_copies(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_text(json.dumps(_valid_aibox_config()), encoding="utf-8")

    monkeypatch.setattr(config, "AIBOX_CONFIG_FILE", str(path))

    aibox_configs = config.get_aibox_configs()
    aibox_configs[0]["name"] = "Renamed"
    aibox_configs[0]["targets"]["192.0.2.21"] = "Camera 2"

    assert config.get_aibox_configs() == _valid_aibox_config()


def test_get_aibox_configs_accepts_local_without_user_or_ip(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    local_config = [
        {
            "name": "Local AIBOXes",
            "check-devices": True,
            "local": True,
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
                "targets": {},
            }
        ]
    )

    assert error == "item 0 (Bad Remote): non-local enabled checks require non-empty user"


def test_v2_config_propagates_target_interface_to_scope_checker(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps(
            {
                "version": 2,
                "aiboxes": [
                    {
                        "id": "box-1",
                        "name": "Box 1",
                        "user": "linaro",
                        "ip": "192.0.2.10",
                        "check-devices": True,
                        "target-interface": "eth0",
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

    assert configs[2]["checkers"] == [
        {
            "name": "Box 1",
            "user": "linaro",
            "ip": "192.0.2.10",
            "target-interface": "eth0",
        }
    ]
