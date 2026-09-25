#!/usr/bin/env python3
"""Validate CookFlow V1 JSON Schemas, examples, and cross-object invariants."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIR = ROOT / "contracts" / "v1" / "schemas"
EXAMPLE_DIR = ROOT / "contracts" / "v1" / "examples"

EXAMPLE_SCHEMAS = {
    "recipe-v1.json": "recipe.schema.json",
    "error-response-v1.json": "error.schema.json",
    "task-schema-v1.json": "task.schema.json",
    "device-schema-v1.json": "device.schema.json",
    "schedule-request-v1.json": "schedule-request.schema.json",
    "schedule-response-v1.json": "schedule-response.schema.json",
    "event-request-v1.json": "event-request.schema.json",
    "replan-response-v1.json": "replan-response.schema.json",
}


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def validate_schedule_request_business_rules(payload: dict[str, Any]) -> list[str]:
    """Return stable V1 business error codes for cross-object request violations."""
    errors: list[str] = []
    tasks = payload["tasks"]
    task_ids = [task["task_id"] for task in tasks]
    known_task_ids = set(task_ids)

    if len(task_ids) != len(known_task_ids):
        errors.append("DUPLICATE_TASK_ID")

    graph: dict[str, list[str]] = {}
    for task in tasks:
        task_id = task["task_id"]
        predecessors = task["predecessors"]
        graph[task_id] = predecessors
        if any(item not in known_task_ids for item in predecessors):
            errors.append("DANGLING_PREDECESSOR")

        manual_duration = task["manual_duration_sec"]
        if (task["manual_required"] and manual_duration <= 0) or (
            not task["manual_required"] and manual_duration != 0
        ):
            errors.append("MANUAL_DURATION_INVALID")

        segments = sorted(task.get("manual_segments", []), key=lambda item: item["offset_sec"])
        previous_end = 0
        for segment in segments:
            segment_end = segment["offset_sec"] + segment["duration_sec"]
            if segment_end > task["duration_sec"]:
                errors.append("MANUAL_SEGMENT_OUT_OF_RANGE")
            if segment["offset_sec"] < previous_end:
                errors.append("MANUAL_SEGMENT_OVERLAP")
            previous_end = max(previous_end, segment_end)

    visiting: set[str] = set()
    visited: set[str] = set()

    def has_cycle(task_id: str) -> bool:
        if task_id in visiting:
            return True
        if task_id in visited:
            return False
        visiting.add(task_id)
        for predecessor in graph.get(task_id, []):
            if predecessor in known_task_ids and has_cycle(predecessor):
                return True
        visiting.remove(task_id)
        visited.add(task_id)
        return False

    if any(has_cycle(task_id) for task_id in task_ids if task_id not in visited):
        errors.append("CYCLIC_DEPENDENCY")

    devices = payload["device_config"]["devices"]
    device_ids = [device["device_id"] for device in devices]
    if len(device_ids) != len(set(device_ids)):
        errors.append("DUPLICATE_DEVICE_ID")

    for device in devices:
        capabilities = device["capabilities"]
        minimum = capabilities.get("temperature_min_c")
        maximum = capabilities.get("temperature_max_c")
        if minimum is not None and maximum is not None and minimum > maximum:
            errors.append("INVALID_TEMPERATURE_RANGE")

    return list(dict.fromkeys(errors))


def run_business_rule_regressions(valid_request: dict[str, Any]) -> None:
    cases: list[tuple[str, dict[str, Any]]] = []

    duplicate = copy.deepcopy(valid_request)
    duplicate["tasks"].append(copy.deepcopy(duplicate["tasks"][0]))
    cases.append(("DUPLICATE_TASK_ID", duplicate))

    dangling = copy.deepcopy(valid_request)
    dangling["tasks"][0]["predecessors"] = ["missing_task"]
    cases.append(("DANGLING_PREDECESSOR", dangling))

    cycle = copy.deepcopy(valid_request)
    cycle["tasks"][0]["predecessors"] = [cycle["tasks"][1]["task_id"]]
    cases.append(("CYCLIC_DEPENDENCY", cycle))

    segment = copy.deepcopy(valid_request)
    segment["tasks"][1]["manual_segments"][1]["offset_sec"] = 470
    cases.append(("MANUAL_SEGMENT_OUT_OF_RANGE", segment))

    devices = copy.deepcopy(valid_request)
    devices["device_config"]["devices"].append(copy.deepcopy(devices["device_config"]["devices"][0]))
    cases.append(("DUPLICATE_DEVICE_ID", devices))

    manual_duration = copy.deepcopy(valid_request)
    manual_duration["tasks"][0]["manual_duration_sec"] = 0
    cases.append(("MANUAL_DURATION_INVALID", manual_duration))

    for expected_code, payload in cases:
        actual = validate_schedule_request_business_rules(payload)
        if expected_code not in actual:
            raise AssertionError(f"business regression failed: expected {expected_code}, got {actual}")
        print(f"business negative case ok: {expected_code}")


def main() -> None:
    schemas = {path.name: load_json(path) for path in sorted(SCHEMA_DIR.glob("*.json"))}
    registry = Registry().with_resources(
        (name, Resource.from_contents(schema)) for name, schema in schemas.items()
    )

    for name, schema in schemas.items():
        Draft202012Validator.check_schema(schema)
        print(f"schema ok: {name}")

    failed = False
    for example_name, schema_name in EXAMPLE_SCHEMAS.items():
        payload = load_json(EXAMPLE_DIR / example_name)
        validator = Draft202012Validator(
            schemas[schema_name], registry=registry, format_checker=FormatChecker()
        )
        errors = sorted(validator.iter_errors(payload), key=lambda error: list(error.path))
        if errors:
            failed = True
            for error in errors:
                path = ".".join(str(part) for part in error.absolute_path) or "<root>"
                print(f"ERROR {example_name} at {path}: {error.message}")
        else:
            print(f"example ok: {example_name} -> {schema_name}")

    valid_request = load_json(EXAMPLE_DIR / "schedule-request-v1.json")
    business_errors = validate_schedule_request_business_rules(valid_request)
    if business_errors:
        failed = True
        print(f"ERROR schedule-request-v1.json business rules: {business_errors}")
    else:
        print("business rules ok: schedule-request-v1.json")
        run_business_rule_regressions(valid_request)

    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
