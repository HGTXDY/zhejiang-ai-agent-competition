"""M1 acceptance checks for contracts and deterministic fixture outcomes."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from scripts.validate_contracts import validate_schedule_request_business_rules

ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))
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




def _independent_hard_constraint_errors(request: dict, result: dict) -> list[str]:
    """Re-check hard constraints from request/result, not scheduler metrics."""
    definitions = {task["task_id"]: task for task in request["tasks"]}
    devices = {device["device_id"]: device for device in request["device_config"]["devices"]}
    scheduled = {task["task_id"]: task for task in result["tasks"]}
    errors: list[str] = []

    for task_id, definition in definitions.items():
        item = scheduled.get(task_id)
        if item is None:
            errors.append(f"missing task: {task_id}")
            continue
        if item["end_offset_sec"] - item["start_offset_sec"] != definition["duration_sec"]:
            errors.append(f"duration mismatch: {task_id}")
        for predecessor in definition["predecessors"]:
            if scheduled[predecessor]["end_offset_sec"] > item["start_offset_sec"]:
                errors.append(f"dependency violation: {task_id}")

    for device_id, device in devices.items():
        intervals = []
        for item in result["tasks"]:
            if device_id not in item["assigned_resources"]:
                continue
            definition = definitions[item["task_id"]]
            demand = definition.get("device_requirement", {}).get("capacity_units", 1)
            intervals.append((item["start_offset_sec"], item["end_offset_sec"], demand))
        events = [(start, 1, demand) for start, end, demand in intervals]
        events += [(end, -1, demand) for start, end, demand in intervals]
        active = 0
        for _, delta, demand in sorted(events, key=lambda event: (event[0], event[1])):
            active += delta * demand
            if active > device["capacity_units"]:
                errors.append(f"device capacity conflict: {device_id}")
                break

    manual_intervals = []
    for item in result["tasks"]:
        definition = definitions[item["task_id"]]
        if not definition.get("manual_required"):
            continue
        segments = definition.get("manual_segments") or [{"offset_sec": 0, "duration_sec": definition["manual_duration_sec"]}]
        for segment in segments:
            manual_intervals.append((
                item["start_offset_sec"] + segment["offset_sec"],
                item["start_offset_sec"] + segment["offset_sec"] + segment["duration_sec"],
            ))
    events = [(start, 1) for start, end in manual_intervals]
    events += [(end, -1) for start, end in manual_intervals]
    active = 0
    for _, delta in sorted(events, key=lambda event: (event[0], event[1])):
        active += delta
        if active > request["device_config"]["operator_count"]:
            errors.append("operator capacity conflict")
            break
    return errors

def test_normal_fixture_runs_validator_scheduler_and_result_checks():
    """Exercise the M1 happy path instead of only validating input documents."""
    from app.scheduler import schedule

    request = _load(FIXTURE_DIR / "four-dish-normal.json")
    schemas, registry = _registry()
    validator = Draft202012Validator(schemas["schedule-request.schema.json"], registry=registry)
    assert list(validator.iter_errors(request)) == []
    assert validate_schedule_request_business_rules(request) == []

    result = schedule(request)

    assert result["validation"]["valid"] is True
    assert result["solver"]["status"] in {"OPTIMAL", "FEASIBLE"}
    assert result["metrics"]["device_conflicts"] == 0
    assert result["metrics"]["dependency_violations"] == 0
    assert _independent_hard_constraint_errors(request, result) == []
    by_id = {task["task_id"]: task for task in result["tasks"]}
    for task in request["tasks"]:
        for predecessor in task["predecessors"]:
            assert by_id[task["task_id"]]["start_offset_sec"] >= by_id[predecessor]["end_offset_sec"]


def test_resource_insufficient_fixture_is_rejected_before_scheduler():
    request = _load(FIXTURE_DIR / "four-dish-resource-insufficient.json")
    assert validate_schedule_request_business_rules(request) == ["DEVICE_TYPE_UNAVAILABLE"]


def test_resource_insufficient_fixture_reaches_scheduler_and_returns_infeasible():
    """Keep the negative path honest: business validation may pass, but CP-SAT must reject it."""
    from app.scheduler import schedule

    request = _load(FIXTURE_DIR / "four-dish-resource-insufficient.json")
    assert validate_schedule_request_business_rules(request) == ["DEVICE_TYPE_UNAVAILABLE"]
    result = schedule(request)
    assert result["solver"]["status"] == "INFEASIBLE"
    assert result["validation"]["valid"] is False
    assert result["validation"]["errors"][0]["code"] == "NO_COMPATIBLE_DEVICE"


def test_acceptance_independently_rejects_tampered_schedule_even_with_clean_metrics():
    from app.scheduler import schedule

    request = _load(FIXTURE_DIR / "four-dish-normal.json")
    result = schedule(request)
    by_id = {task["task_id"]: task for task in result["tasks"]}
    by_id["fish_steam"]["start_offset_sec"] = by_id["fish_prepare"]["start_offset_sec"]
    by_id["fish_steam"]["end_offset_sec"] = by_id["fish_steam"]["start_offset_sec"] + request["tasks"][4]["duration_sec"]
    result["metrics"]["device_conflicts"] = 0
    result["metrics"]["dependency_violations"] = 0

    errors = _independent_hard_constraint_errors(request, result)
    assert any(error.startswith("dependency violation") for error in errors)
    assert any(error.startswith("operator capacity conflict") for error in errors)
