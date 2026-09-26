"""M1 acceptance checks for contracts and deterministic fixture outcomes."""
from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from scripts.validate_contracts import validate_schedule_request_business_rules

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIR = ROOT / "contracts/v1/schemas"
EXAMPLE_DIR = ROOT / "contracts/v1/examples"
FIXTURE_DIR = ROOT / "fixtures/v1"


def _load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _registry():
    schemas = {path.name: _load(path) for path in SCHEMA_DIR.glob("*.json")}
    return schemas, Registry().with_resources((name, Resource.from_contents(schema)) for name, schema in schemas.items())


def test_all_contract_examples_are_schema_valid():
    schemas, registry = _registry()
    mapping = {
        "recipe-v1.json": "recipe.schema.json",
        "error-response-v1.json": "error.schema.json",
        "task-schema-v1.json": "task.schema.json",
        "device-schema-v1.json": "device.schema.json",
        "schedule-request-v1.json": "schedule-request.schema.json",
        "schedule-response-v1.json": "schedule-response.schema.json",
        "event-request-v1.json": "event-request.schema.json",
        "replan-response-v1.json": "replan-response.schema.json",
    }
    for example, schema_name in mapping.items():
        validator = Draft202012Validator(schemas[schema_name], registry=registry, format_checker=FormatChecker())
        assert list(validator.iter_errors(_load(EXAMPLE_DIR / example))) == [], example


def test_fixture_manifest_covers_expected_m1_scenarios():
    manifest = _load(FIXTURE_DIR / "manifest.json")
    schemas, registry = _registry()
    validator = Draft202012Validator(schemas["schedule-request.schema.json"], registry=registry)
    assert len(manifest["fixtures"]) >= 3
    for entry in manifest["fixtures"]:
        payload = _load(FIXTURE_DIR / entry["file"])
        assert list(validator.iter_errors(payload)) == [], entry["file"]
        assert validate_schedule_request_business_rules(payload) == entry["expected_business_errors"]


def test_m1_scenario_expectations_are_explicit():
    manifest = _load(FIXTURE_DIR / "manifest.json")
    by_file = {entry["file"]: entry["expected_business_errors"] for entry in manifest["fixtures"]}
    assert by_file["four-dish-normal.json"] == []
    assert by_file["four-dish-resource-insufficient.json"] == ["DEVICE_TYPE_UNAVAILABLE"]
    assert by_file["four-dish-mode-conflict.json"] == ["DEVICE_MODE_UNSUPPORTED"]
