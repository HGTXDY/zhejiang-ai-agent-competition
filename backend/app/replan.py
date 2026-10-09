"""Contract-shaped event-driven dynamic replanning service."""
from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from app.execution import ExecutionStateMachine, EventError, build_notifications, compare_schedules
from app.scheduler import SchedulerConfig, schedule
from app.validation import annotate_schedule_result
from scripts.validate_contracts import validate_schedule_request_business_rules

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIR = ROOT / ".." / "contracts" / "v1" / "schemas"


def _load_schemas() -> tuple[dict[str, dict[str, Any]], Registry]:
    schemas = {path.name: json.loads(path.read_text(encoding="utf-8")) for path in SCHEMA_DIR.glob("*.json")}
    registry = Registry().with_resources((name, Resource.from_contents(schema)) for name, schema in schemas.items())
    return schemas, registry


SCHEMAS, REGISTRY = _load_schemas()
EVENT_VALIDATOR = Draft202012Validator(SCHEMAS["event-request.schema.json"], registry=REGISTRY, format_checker=FormatChecker())
REQUEST_VALIDATOR = Draft202012Validator(SCHEMAS["schedule-request.schema.json"], registry=REGISTRY, format_checker=FormatChecker())
REPLAN_REQUEST_VALIDATOR = Draft202012Validator(SCHEMAS["replan-request.schema.json"], registry=REGISTRY, format_checker=FormatChecker())


class ReplanError(ValueError):
    def __init__(self, code: str, message: str, *, status_code: int = 422, details: list[dict[str, Any]] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or []


def _schema_errors(validator: Draft202012Validator, value: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"code": "SCHEMA_VALIDATION_ERROR", "message": error.message, "path": ".".join(str(part) for part in error.absolute_path) or "$"}
        for error in sorted(validator.iter_errors(value), key=lambda item: list(item.absolute_path))
    ]


def apply_event_to_request(request: dict[str, Any], event: dict[str, Any]) -> None:
    """Mutate a schedule request in place to reflect an accepted event.

    DISH_ADDED appends new tasks; DEVICE_UNAVAILABLE marks the affected device
    unavailable. The replan service and the stateful REST layer share this helper
    so a stored request always stays in sync with the latest schedule lineage.
    """
    if event["event_type"] == "DISH_ADDED":
        request_by_id = {task["task_id"] for task in request["tasks"]}
        for task in event["payload"]["tasks"]:
            if task["task_id"] not in request_by_id:
                request["tasks"].append(task)
                request_by_id.add(task["task_id"])
    if event["event_type"] == "DEVICE_UNAVAILABLE":
        device_id = event["payload"]["device_id"]
        for device in request["device_config"]["devices"]:
            if device["device_id"] == device_id:
                device["available"] = False
    if event["event_type"] == "DEVICE_ADDED":
        request_devices = {device["device_id"] for device in request["device_config"]["devices"]}
        for device in event["payload"]["devices"]:
            if device["device_id"] in request_devices:
                raise ReplanError("DUPLICATE_DEVICE", f"Device {device['device_id']} is already configured")
            request["device_config"]["devices"].append(device)
            request_devices.add(device["device_id"])


# Existing request business checks include *availability* for every task.
# In a rolling replan, completed tasks may have used a device that has since
# failed. Keep all structural checks, but defer compatibility after a failure
# to CP-SAT (which understands pinned history vs. mutable future tasks).
_CAPABILITY_ERRORS = {
    "DEVICE_TYPE_UNAVAILABLE", "DEVICE_MODE_UNSUPPORTED",
    "DEVICE_TEMPERATURE_UNSUPPORTED", "DEVICE_CAPACITY_INSUFFICIENT",
}


def _replan_business_errors(request: dict[str, Any]) -> list[str]:
    errors = validate_schedule_request_business_rules(request)
    if any(not device.get("available", True) for device in request["device_config"]["devices"]):
        errors = [error for error in errors if error not in _CAPABILITY_ERRORS]
    return errors


def replan(
    envelope: dict[str, Any], *,
    scheduler_config: SchedulerConfig | None = None,
    stage_diagnostics: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Apply one event and produce a V1 replan response.

    The endpoint intentionally receives the current schedule and its original
    scheduling request. This keeps the first implementation stateless while
    making the lock/replan semantics explicit and testable.
    """
    required = {"event", "schedule_request", "current_schedule"}
    missing = sorted(required - envelope.keys())
    if missing:
        raise ReplanError("INVALID_REPLAN_REQUEST", f"Missing fields: {missing}")
    envelope_errors = _schema_errors(REPLAN_REQUEST_VALIDATOR, envelope)
    if envelope_errors:
        raise ReplanError("INVALID_INPUT", "Replan request does not satisfy V1 schema", details=envelope_errors)
    event = envelope["event"]
    request = deepcopy(envelope["schedule_request"])
    previous = deepcopy(envelope["current_schedule"])
    event_errors = _schema_errors(EVENT_VALIDATOR, event)
    if event_errors:
        raise ReplanError("INVALID_INPUT", "Event does not satisfy V1 schema", details=event_errors)
    request_errors = _schema_errors(REQUEST_VALIDATOR, request)
    if request_errors:
        raise ReplanError("INVALID_INPUT", "Schedule request does not satisfy V1 schema", details=request_errors)
    business_errors = _replan_business_errors(request)
    if business_errors:
        raise ReplanError("VALIDATION_FAILED", "Schedule request violates V1 business rules", details=[{"code": code, "message": code, "path": None} for code in business_errors])
    if previous.get("schedule_id") != event["schedule_id"]:
        raise ReplanError("SCHEDULE_MISMATCH", "Event schedule_id does not match current schedule")
    if request["request_id"] != previous["request_id"]:
        raise ReplanError("SCHEDULE_MISMATCH", "Schedule request ID differs from the current schedule")
    # A stateless caller must send the full request lineage from the preceding
    # successful replan. Reject stale/incomplete contexts rather than silently
    # dropping a previously added dish from the task network.
    if {task["task_id"] for task in request["tasks"]} != {task["task_id"] for task in previous["tasks"]}:
        raise ReplanError("SCHEDULE_MISMATCH", "Request tasks differ from current schedule; stale replan lineage")

    if event["event_type"] == "DEVICE_UNAVAILABLE":
        device_id = event["payload"]["device_id"]
        configured_devices = {device["device_id"] for device in request["device_config"]["devices"]}
        if device_id not in configured_devices:
            raise ReplanError(
                "UNKNOWN_DEVICE",
                f"Device {device_id} is not present in the schedule request",
                details=[{"code": "UNKNOWN_DEVICE", "message": device_id, "path": "event.payload.device_id"}],
            )
    if event["event_type"] == "DEVICE_ADDED":
        configured_devices = {device["device_id"] for device in request["device_config"]["devices"]}
        for device in event["payload"]["devices"]:
            if device["device_id"] in configured_devices:
                raise ReplanError(
                    "DUPLICATE_DEVICE",
                    f"Device {device['device_id']} is already present in the schedule request",
                    details=[{"code": "DUPLICATE_DEVICE", "message": device["device_id"], "path": "event.payload.devices"}],
                )

    machine = ExecutionStateMachine(previous)
    try:
        result = machine.apply(event)
    except EventError as error:
        raise ReplanError(error.code, error.message) from error
    updated = machine.schedule

    apply_event_to_request(request, event)
    updated_business_errors = _replan_business_errors(request)
    if updated_business_errors:
        raise ReplanError(
            "VALIDATION_FAILED",
            "Event produces a schedule request that violates V1 business rules",
            details=[
                {"code": code, "message": code, "path": None}
                for code in updated_business_errors
            ],
        )

    current_tasks = {task["task_id"]: task for task in updated.get("tasks", [])}
    locked_tasks = {
        task_id: task
        for task_id, task in current_tasks.items()
        if task.get("locked") or task.get("status") in {"LOCKED", "RUNNING", "COMPLETED"}
    }
    start_floors: dict[str, int] = {}
    if event["event_type"] == "TASK_DELAYED":
        task_id = event["payload"]["task_id"]
        old_task = next((task for task in previous.get("tasks", []) if task["task_id"] == task_id), None)
        if old_task is not None:
            start_floors[task_id] = old_task.get("start_offset_sec", 0) + event["payload"]["delay_sec"]

    candidate = schedule(
        request, config=scheduler_config, locked_tasks=locked_tasks,
        start_floors=start_floors, previous_schedule=previous,
        stage_diagnostics=stage_diagnostics,
    )
    if candidate["solver"]["status"] == "UNKNOWN":
        raise ReplanError("SOLVER_TIMEOUT", "Replan solver timed out", status_code=504)
    if candidate["solver"]["status"] == "INFEASIBLE":
        raise ReplanError("SCHEDULE_INFEASIBLE", "No feasible replan found", status_code=409, details=candidate["validation"]["errors"])

    for task in candidate["tasks"]:
        state = current_tasks.get(task["task_id"])
        if state:
            task["status"] = state.get("status", task["status"])
            task["locked"] = bool(state.get("locked", task["locked"]))
    historical_ids = frozenset(
        task_id for task_id, task in locked_tasks.items()
        if task.get("locked") or task.get("status") in {"COMPLETED", "LOCKED"}
    )
    annotate_schedule_result(request, candidate, historical_task_ids=historical_ids)
    if not candidate["validation"]["valid"]:
        raise ReplanError("VALIDATION_FAILED", "Replan result failed independent validation", status_code=409,
                          details=candidate["validation"]["errors"])
    candidate["schedule_id"] = f"{previous['schedule_id']}:replan:{event['event_id']}"
    changes, metrics = compare_schedules(previous.get("tasks", []), candidate["tasks"], notified_task_ids=set(result.affected_task_ids))
    task_meta = {task["task_id"]: task for task in request.get("tasks", [])}
    notifications = build_notifications(
        changes,
        created_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        task_meta=task_meta,
    )
    candidate["notifications"] = [
        *(candidate.get("notifications") or []),
        *notifications,
    ]
    return {
        "schema_version": "1.0",
        "event_id": event["event_id"],
        "previous_schedule_id": previous["schedule_id"],
        "schedule": candidate,
        "changes": changes,
        "disruption_metrics": metrics,
        "disruption_score": float(metrics["start_offset_total_sec"] + metrics["resource_change_count"] * 60 + metrics["order_change_count"] * 30),
    }
