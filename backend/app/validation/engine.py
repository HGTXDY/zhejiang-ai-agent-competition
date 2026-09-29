"""Pure V1 request and schedule validation, independent of FastAPI and OR-Tools."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from app.validation.models import ScheduleRequest

ROOT = Path(__file__).resolve().parents[3]
SCHEMA_DIR = ROOT / "contracts" / "v1" / "schemas"


@dataclass(frozen=True)
class ValidationIssue:
    code: str
    message: str
    path: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "path": self.path}


@dataclass(frozen=True)
class ValidationResult:
    valid: bool
    errors: tuple[ValidationIssue, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {"valid": self.valid, "errors": [error.as_dict() for error in self.errors]}


def _schema_validator(filename: str) -> Draft202012Validator:
    schemas = {path.name: json.loads(path.read_text(encoding="utf-8")) for path in SCHEMA_DIR.glob("*.json")}
    registry = Registry().with_resources((name, Resource.from_contents(schema)) for name, schema in schemas.items())
    return Draft202012Validator(schemas[filename], registry=registry, format_checker=FormatChecker())


REQUEST_VALIDATOR = _schema_validator("schedule-request.schema.json")
RESPONSE_VALIDATOR = _schema_validator("schedule-response.schema.json")


def _schema_issues(validator: Draft202012Validator, value: dict[str, Any]) -> list[ValidationIssue]:
    return [
        ValidationIssue("SCHEMA_VALIDATION_ERROR", error.message, ".".join(str(part) for part in error.absolute_path) or None)
        for error in sorted(validator.iter_errors(value), key=lambda item: list(item.absolute_path))
    ]


def validate_schedule_request(request: dict[str, Any]) -> ValidationResult:
    """Validate schema, cross-object invariants, and device capability feasibility."""
    errors = _schema_issues(REQUEST_VALIDATOR, request)
    if errors:
        return ValidationResult(False, tuple(errors))
    try:
        model = ScheduleRequest.model_validate(request)
    except ValueError as error:
        return ValidationResult(False, (ValidationIssue("PYDANTIC_VALIDATION_ERROR", str(error)),))

    errors = _request_invariants(model)
    return ValidationResult(not errors, tuple(errors))


def _request_invariants(request: ScheduleRequest) -> list[ValidationIssue]:
    errors: list[ValidationIssue] = []
    task_by_id = {task.task_id: task for task in request.tasks}
    if len(task_by_id) != len(request.tasks):
        errors.append(ValidationIssue("DUPLICATE_TASK_ID", "task_id values must be unique", "tasks"))

    device_by_id = {device.device_id: device for device in request.device_config.devices}
    if len(device_by_id) != len(request.device_config.devices):
        errors.append(ValidationIssue("DUPLICATE_DEVICE_ID", "device_id values must be unique", "device_config.devices"))

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(task_id: str) -> None:
        if task_id in visiting:
            errors.append(ValidationIssue("CYCLIC_DEPENDENCY", f"dependency cycle includes {task_id}", f"tasks[{task_id}].predecessors"))
            return
        if task_id in visited or task_id not in task_by_id:
            return
        visiting.add(task_id)
        task = task_by_id[task_id]
        for predecessor in task.predecessors:
            if predecessor not in task_by_id:
                errors.append(ValidationIssue("DANGLING_PREDECESSOR", f"unknown predecessor {predecessor}", f"tasks[{task_id}].predecessors"))
            else:
                visit(predecessor)
        visiting.remove(task_id)
        visited.add(task_id)

    for task in request.tasks:
        visit(task.task_id)
        if task.manual_required and task.manual_duration_sec <= 0:
            errors.append(ValidationIssue("MANUAL_DURATION_INVALID", "manual_duration_sec must be positive when manual_required is true", f"tasks[{task.task_id}].manual_duration_sec"))
        if not task.manual_required and task.manual_duration_sec != 0:
            errors.append(ValidationIssue("MANUAL_DURATION_INVALID", "manual_duration_sec must be zero when manual_required is false", f"tasks[{task.task_id}].manual_duration_sec"))
        previous_end = 0
        for index, segment in enumerate(sorted(task.manual_segments, key=lambda item: item.offset_sec)):
            segment_end = segment.offset_sec + segment.duration_sec
            if segment_end > task.duration_sec:
                errors.append(ValidationIssue("MANUAL_SEGMENT_OUT_OF_RANGE", "manual segment exceeds task duration", f"tasks[{task.task_id}].manual_segments[{index}]"))
            if segment.offset_sec < previous_end:
                errors.append(ValidationIssue("MANUAL_SEGMENT_OVERLAP", "manual segments overlap", f"tasks[{task.task_id}].manual_segments[{index}]"))
            previous_end = max(previous_end, segment_end)

        if task.device_requirement is not None and not _compatible_devices(task, request.device_config.devices):
            errors.append(ValidationIssue("NO_COMPATIBLE_DEVICE", f"no compatible available device for task {task.task_id}", f"tasks[{task.task_id}].device_requirement"))

    for device in request.device_config.devices:
        minimum = device.capabilities.temperature_min_c
        maximum = device.capabilities.temperature_max_c
        if minimum is not None and maximum is not None and minimum > maximum:
            errors.append(ValidationIssue("INVALID_TEMPERATURE_RANGE", "temperature_min_c must not exceed temperature_max_c", f"device_config.devices[{device.device_id}].capabilities"))
    return _dedupe(errors)


def _compatible_devices(task: Any, devices: Iterable[Any]) -> list[str]:
    requirement = task.device_requirement
    if requirement is None:
        return []
    matches: list[str] = []
    for device in devices:
        if not device.available or device.device_type != requirement.device_type:
            continue
        if requirement.mode is not None and requirement.mode not in device.capabilities.modes:
            continue
        minimum = device.capabilities.temperature_min_c
        maximum = device.capabilities.temperature_max_c
        if requirement.temperature_c is not None and ((minimum is not None and requirement.temperature_c < minimum) or (maximum is not None and requirement.temperature_c > maximum)):
            continue
        if device.capacity_units < requirement.capacity_units:
            continue
        matches.append(device.device_id)
    return matches


def build_device_candidates(request: dict[str, Any]) -> dict[str, list[str]]:
    """Return deterministic candidate device IDs for every device-bound task."""
    model = ScheduleRequest.model_validate(request)
    return {
        task.task_id: _compatible_devices(task, model.device_config.devices)
        for task in model.tasks
        if task.device_requirement is not None
    }


def validate_schedule_result(request: dict[str, Any], response: dict[str, Any]) -> ValidationResult:
    """Validate a schedule response and independently check resource/time invariants."""
    errors = _schema_issues(RESPONSE_VALIDATOR, response)
    if errors:
        return ValidationResult(False, tuple(errors))
    request_result = validate_schedule_request(request)
    if not request_result.valid:
        return request_result
    model = ScheduleRequest.model_validate(request)
    task_defs = {task.task_id: task for task in model.tasks}
    scheduled = {task["task_id"]: task for task in response["tasks"]}
    if set(scheduled) != set(task_defs):
        return ValidationResult(False, (ValidationIssue("TASK_SET_MISMATCH", "schedule result task IDs must match request task IDs", "tasks"),))

    errors = []
    for task_id, definition in task_defs.items():
        item = scheduled[task_id]
        start, end = item["start_offset_sec"], item["end_offset_sec"]
        if end - start != definition.duration_sec:
            errors.append(ValidationIssue("TASK_DURATION_MISMATCH", f"task duration does not match request for {task_id}", f"tasks[{task_id}]"))
        for predecessor in definition.predecessors:
            if scheduled[predecessor]["end_offset_sec"] > start:
                errors.append(ValidationIssue("DEPENDENCY_VIOLATION", f"{task_id} starts before predecessor {predecessor} completes", f"tasks[{task_id}].start_offset_sec"))
        candidate_ids = set(_compatible_devices(definition, model.device_config.devices))
        assigned_devices = {resource for resource in item["assigned_resources"] if resource in {device.device_id for device in model.device_config.devices}}
        if definition.device_requirement is not None and not assigned_devices.intersection(candidate_ids):
            errors.append(ValidationIssue("RESOURCE_CAPABILITY_MISMATCH", f"task {task_id} is assigned no compatible device", f"tasks[{task_id}].assigned_resources"))

    errors.extend(_resource_conflicts(model, response["tasks"]))
    return ValidationResult(not errors, tuple(_dedupe(errors)))


def _resource_conflicts(request: ScheduleRequest, scheduled_tasks: list[dict[str, Any]]) -> list[ValidationIssue]:
    devices = {device.device_id: device for device in request.device_config.devices}
    definitions = {task.task_id: task for task in request.tasks}
    errors: list[ValidationIssue] = []
    for device_id, device in devices.items():
        intervals: list[tuple[int, int, int, str]] = []
        for item in scheduled_tasks:
            if device_id not in item["assigned_resources"]:
                continue
            definition = definitions[item["task_id"]]
            demand = definition.device_requirement.capacity_units if definition.device_requirement else 1
            intervals.append((item["start_offset_sec"], item["end_offset_sec"], demand, item["task_id"]))
        errors.extend(
            _capacity_conflicts(
                intervals,
                device.capacity_units,
                "DEVICE_CAPACITY_CONFLICT",
                f"device {device_id}",
            )
        )

    operator_intervals: list[tuple[int, int, int, str]] = []
    for item in scheduled_tasks:
        definition = definitions[item["task_id"]]
        if not definition.manual_required:
            continue
        if definition.manual_segments:
            segments = [(segment.offset_sec, segment.duration_sec) for segment in definition.manual_segments]
        else:
            segments = [(0, definition.manual_duration_sec)]
        for offset_sec, duration_sec in segments:
            start = item["start_offset_sec"] + offset_sec
            end = start + duration_sec
            operator_intervals.append((start, end, 1, item["task_id"]))
    errors.extend(
        _capacity_conflicts(
            operator_intervals,
            request.device_config.operator_count,
            "OPERATOR_CAPACITY_CONFLICT",
            "manual operator capacity",
        )
    )
    return errors


def _capacity_conflicts(
    intervals: list[tuple[int, int, int, str]],
    capacity: int,
    code: str,
    resource_label: str,
) -> list[ValidationIssue]:
    """Find any time window whose total demand exceeds a resource capacity.

    End events are processed before start events at the same timestamp, so
    back-to-back tasks are allowed. The sweep also catches three or more
    simultaneous tasks, which pairwise checks cannot reliably detect.
    """
    events: list[tuple[int, int, int, str]] = []
    for start, end, demand, task_id in intervals:
        if start >= end:
            continue
        events.append((start, 1, demand, task_id))
        events.append((end, -1, demand, task_id))

    active_demand = 0
    active_tasks: set[str] = set()
    errors: list[ValidationIssue] = []
    # delta -1 sorts before +1 at equal timestamps.
    for timestamp, delta, demand, task_id in sorted(events, key=lambda item: (item[0], item[1])):
        if delta < 0:
            active_demand -= demand
            active_tasks.discard(task_id)
            continue
        active_demand += demand
        active_tasks.add(task_id)
        if active_demand > capacity:
            task_names = ", ".join(sorted(active_tasks))
            errors.append(
                ValidationIssue(
                    code,
                    f"tasks {task_names} exceed {resource_label} capacity {capacity} at offset {timestamp}s",
                    "tasks",
                )
            )
    return errors


def _dedupe(errors: Iterable[ValidationIssue]) -> list[ValidationIssue]:
    seen: set[tuple[str, str | None]] = set()
    result: list[ValidationIssue] = []
    for error in errors:
        key = (error.code, error.path)
        if key not in seen:
            seen.add(key)
            result.append(error)
    return result
