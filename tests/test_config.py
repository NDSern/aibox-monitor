import json

import config


def _valid_aibox_config():
    return [
        {
            "name": "Site 1",
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
