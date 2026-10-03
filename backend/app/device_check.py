"""Standalone device-configuration validation for `POST /devices/validate`.

Reuses the V1 device schema and the same business error codes as the schedule
request validator, so a device report and a full schedule validation never
disagree about a device.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIR = ROOT / "contracts" / "v1" / "schemas"

_SCHEMAS = {path.name: json.loads(path.read_text(encoding="utf-8")) for path in SCHEMA_DIR.glob("*.json")}
_REGISTRY = Registry().with_resources((name, Resource.from_contents(schema)) for name, schema in _SCHEMAS.items())
DEVICE_VALIDATOR = Draft202012Validator(_SCHEMAS["device.schema.json"], registry=_REGISTRY, format_checker=FormatChecker())


def validate_device_config(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate a `device_config` object and return a capability report."""
    errors: list[dict[str, Any]] = []
    for error in sorted(DEVICE_VALIDATOR.iter_errors(payload), key=lambda item: list(item.absolute_path)):
        errors.append(
            {
                "code": "SCHEMA_VALIDATION_ERROR",
                "message": error.message,
                "path": ".".join(str(part) for part in error.absolute_path) or "$",
            }
        )
    if errors:
        return {"schema_version": "1.0", "valid": False, "errors": errors, "devices": []}

    devices = payload.get("devices", [])
    device_ids = [device["device_id"] for device in devices]
    if len(device_ids) != len(set(device_ids)):
        errors.append({"code": "DUPLICATE_DEVICE_ID", "message": "device_id values must be unique", "path": "devices"})

    for device in devices:
        capabilities = device.get("capabilities", {})
        minimum = capabilities.get("temperature_min_c")
        maximum = capabilities.get("temperature_max_c")
        if minimum is not None and maximum is not None and minimum > maximum:
            errors.append(
                {
                    "code": "INVALID_TEMPERATURE_RANGE",
                    "message": "temperature_min_c must not exceed temperature_max_c",
                    "path": f"devices[{device['device_id']}].capabilities",
                }
            )

    reports = [
        {
            "device_id": device["device_id"],
            "device_type": device["device_type"],
            "available": device.get("available", True),
            "capacity_units": device.get("capacity_units"),
            "modes": device.get("capabilities", {}).get("modes", []),
            "temperature_range_c": [
                device.get("capabilities", {}).get("temperature_min_c"),
                device.get("capabilities", {}).get("temperature_max_c"),
            ],
        }
        for device in devices
    ]

    return {"schema_version": "1.0", "valid": not errors, "errors": errors, "devices": reports}
