import json
import logging
import os
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

PING_INTERVAL_SECONDS = 10 * 60
PING_TIMEOUT_SECONDS = 2
CPU_THRESHOLD = 90
RAM_THRESHOLD = 90
NPU_THRESHOLD = 90

DEFAULT_AIBOXES = {
    "100.64.0.49": "Cảng Gia Minh - Hải Phòng",
}
AIBOXES_FILE = os.getenv("AIBOXES_FILE", "aiboxes.json")
AIBOX_CONFIG_FILE = os.getenv("AIBOX_CONFIG_FILE", "config.json")
AIBOXES = DEFAULT_AIBOXES

_aiboxes_cache = DEFAULT_AIBOXES
_aibox_config_cache = []


def _load_json_file(file_path: str):
    with open(file_path, encoding="utf-8") as f:
        return json.load(f)


def _is_valid_aiboxes(value) -> bool:
    return (
        isinstance(value, dict)
        and bool(value)
        and all(isinstance(ip, str) and ip for ip in value)
        and all(isinstance(name, str) and name for name in value.values())
    )








def _is_valid_target_map(value) -> bool:
    return (
        isinstance(value, dict)
        and all(isinstance(ip, str) and ip for ip in value)
        and all(isinstance(name, str) and name for name in value.values())
    )


def _is_valid_aibox_config(value) -> bool:
    return _aibox_config_error(value) is None


def _aibox_config_error(value) -> str | None:
    if not (
        isinstance(value, dict)
        and isinstance(value.get("name"), str)
        and bool(value["name"])
    ):
        return "must be an object with non-empty name"

    if "targets" in value and not _is_valid_target_map(value["targets"]):
        return "targets must be an object of IP/name strings"

    check_devices = value.get("check-devices", False)
    if not isinstance(check_devices, bool):
        return "check-devices must be a boolean when present"

    check_resource = value.get("check-resource", False)
    if not isinstance(check_resource, bool):
        return "check-resource must be a boolean when present"

    local = value.get("local", False)
    if not isinstance(local, bool):
        return "local must be a boolean when present"

    if local:
        return None

    if not check_devices and not check_resource:
        return None

    if not (isinstance(value.get("user"), str) and bool(value["user"])):
        return "non-local enabled checks require non-empty user"
    if not (isinstance(value.get("ip"), str) and bool(value["ip"])):
        return "non-local enabled checks require non-empty ip"

    return None


def _is_valid_aibox_config_list(value) -> bool:
    return isinstance(value, list) and all(_is_valid_aibox_config(item) for item in value)


def _aibox_config_list_error(value) -> str | None:
    if not isinstance(value, list):
        return "top-level config must be a list"
    for index, item in enumerate(value):
        error = _aibox_config_error(item)
        if error:
            name = item.get("name", "<unknown>") if isinstance(item, dict) else "<not object>"
            return f"item {index} ({name}): {error}"
    return None


def _normalize_v2_config(value: dict) -> list[dict]:
    aiboxes = value.get("aiboxes")
    target_scopes = value.get("target_scopes", [])
    if not isinstance(aiboxes, list) or not isinstance(target_scopes, list):
        raise ValueError("v2 config requires aiboxes and target_scopes lists")

    for item in aiboxes:
        target_interface = item.get("target-interface")
        if target_interface is not None and (not isinstance(target_interface, str) or not target_interface):
            raise ValueError(f"v2 target-interface for {item.get('name', '<unknown>')} must be a non-empty string")

    normalized = [
        {
            "name": "Kiểm tra trạng thái các AIBOX",
            "check-devices": True,
            "check-resource": False,
            "local": True,
            "user": "",
            "ip": "",
            "targets": {item["ip"]: item["name"] for item in aiboxes},
        }
    ]

    for item in aiboxes:
        normalized.append(
            {
                "id": item.get("id", item["ip"]),
                "name": item["name"],
                "check-devices": False,
                "check-resource": item.get("check-resource", False),
                "local": False,
                "user": item.get("user", ""),
                "ip": item["ip"],
                "targets": {},
            }
        )

    for scope in target_scopes:
        networks = [scope["id"]]
        checkers = []
        for item in aiboxes:
            if not (item.get("check-devices", False) and any(network in item.get("networks", []) for network in networks)):
                continue
            checker = {
                "name": item["name"],
                "user": item.get("user", ""),
                "ip": item["ip"],
            }
            if item.get("target-interface"):
                checker["target-interface"] = item["target-interface"]
            checkers.append(checker)
        normalized.append(
            {
                "id": scope["id"],
                "name": scope["name"],
                "check-devices": True,
                "check-resource": False,
                "local": False,
                "user": checkers[0]["user"] if checkers else "",
                "ip": checkers[0]["ip"] if checkers else "",
                "targets": dict(scope.get("targets", {})),
                "checkers": checkers,
            }
        )

    return normalized


def get_aiboxes() -> dict[str, str]:
    global _aiboxes_cache

    try:
        aiboxes = _load_json_file(AIBOXES_FILE)
        if not _is_valid_aiboxes(aiboxes):
            raise ValueError("AIBOX JSON must be a non-empty object of IP/name strings")
        _aiboxes_cache = dict(aiboxes)
    except (OSError, json.JSONDecodeError, ValueError) as e:
        logger.warning(f"Using cached AIBOX config after failed JSON load: {e}")

    return dict(_aiboxes_cache)




def get_aibox_configs() -> list[dict]:
    global _aibox_config_cache

    try:
        aibox_configs = _load_json_file(AIBOX_CONFIG_FILE)
        if isinstance(aibox_configs, dict) and aibox_configs.get("version") == 2:
            aibox_configs = _normalize_v2_config(aibox_configs)
        config_error = _aibox_config_list_error(aibox_configs)
        if config_error:
            raise ValueError(f"AIBOX config JSON invalid: {config_error}")
        _aibox_config_cache = []
        for item in aibox_configs:
            normalized_item = {
                "name": item["name"],
                "check-devices": item.get("check-devices", False),
                "check-resource": item.get("check-resource", False),
                "local": item.get("local", False),
                "user": item.get("user", ""),
                "ip": item.get("ip", ""),
                "targets": dict(item.get("targets", {})),
            }
            if "id" in item:
                normalized_item["id"] = item["id"]
            if "checkers" in item:
                normalized_item["checkers"] = list(item["checkers"])
            _aibox_config_cache.append(normalized_item)
    except (OSError, json.JSONDecodeError, ValueError) as e:
        logger.warning(f"Using cached AIBOX target config after failed JSON load: {e}")

    configs = []
    for item in _aibox_config_cache:
        config_item = {
            "name": item["name"],
            "check-devices": item.get("check-devices", False),
            "check-resource": item.get("check-resource", False),
            "local": item.get("local", False),
            "user": item.get("user", ""),
            "ip": item.get("ip", ""),
            "targets": dict(item.get("targets", {})),
        }
        if "id" in item:
            config_item["id"] = item["id"]
        if "checkers" in item:
            config_item["checkers"] = list(item["checkers"])
        configs.append(config_item)
    return configs

LOG_FILE = "aibox_monitor.log"
LOG_LEVEL = "INFO"
