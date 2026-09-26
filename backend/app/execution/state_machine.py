"""Event-driven execution state primitives for V1 replan integration.

This module owns state transitions and lock protection. It deliberately does not
solve a new schedule; the replan service can consume `affected_task_ids` and pass
only mutable tasks to the scheduler.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any

ALLOWED_EVENTS = {"TASK_COMPLETED", "TASK_DELAYED", "DISH_ADDED", "DEVICE_UNAVAILABLE"}
LOCKED_STATUSES = {"RUNNING", "COMPLETED", "LOCKED"}


class EventError(ValueError):
    """Stable event-processing error with a machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class EventResult:
    event_id: str
    accepted: bool
    affected_task_ids: tuple[str, ...]
    notifications: tuple[dict[str, Any], ...] = ()


class ExecutionStateMachine:
    """Apply V1 execution events without mutating locked task assignments."""

    def __init__(self, schedule: dict[str, Any]) -> None:
        self._schedule = deepcopy(schedule)
        self._tasks = {task["task_id"]: task for task in self._schedule.get("tasks", [])}
        if len(self._tasks) != len(self._schedule.get("tasks", [])):
            raise EventError("DUPLICATE_TASK_ID", "Schedule contains duplicate task_id")
        self._events: set[str] = set()

    @property
    def schedule(self) -> dict[str, Any]:
        return deepcopy(self._schedule)

    def apply(self, event: dict[str, Any]) -> EventResult:
        self._validate_event_shape(event)
        event_id = event["event_id"]
        if event_id in self._events:
            raise EventError("DUPLICATE_EVENT", f"Event {event_id} was already applied")
        if event["schedule_id"] != self._schedule["schedule_id"]:
            raise EventError("SCHEDULE_MISMATCH", "Event schedule_id does not match current schedule")

        event_type = event["event_type"]
        payload = event["payload"]
        if event_type == "TASK_COMPLETED":
            result = self._complete(event_id, payload["task_id"])
        elif event_type == "TASK_DELAYED":
            result = self._delay(event_id, payload["task_id"], payload["delay_sec"])
        elif event_type == "DEVICE_UNAVAILABLE":
            result = self._device_unavailable(event_id, payload["device_id"])
        else:
            result = self._dish_added(event_id, payload["tasks"])
        self._events.add(event_id)
        return result

    def _complete(self, event_id: str, task_id: str) -> EventResult:
        task = self._task(task_id)
        if task["status"] == "COMPLETED":
            raise EventError("INVALID_STATE_TRANSITION", f"Task {task_id} is already completed")
        if task["status"] == "CANCELLED":
            raise EventError("INVALID_STATE_TRANSITION", f"Cancelled task {task_id} cannot complete")
        task["status"] = "COMPLETED"
        task["locked"] = True
        affected = tuple(self._dependents(task_id))
        return EventResult(event_id, True, affected)

    def _delay(self, event_id: str, task_id: str, delay_sec: int) -> EventResult:
        task = self._task(task_id)
        self._assert_mutable(task)
        task["status"] = "DELAYED"
        affected = tuple(self._dependents(task_id))
        notification = {
            "type": "task_delayed",
            "task_id": task_id,
            "delay_sec": delay_sec,
        }
        return EventResult(event_id, True, affected, (notification,))

    def _device_unavailable(self, event_id: str, device_id: str) -> EventResult:
        affected = []
        for task in self._tasks.values():
            if device_id not in task.get("assigned_resources", []):
                continue
            if task.get("status") in {"COMPLETED", "CANCELLED"}:
                continue
            if task.get("locked") or task.get("status") in LOCKED_STATUSES:
                # The task remains unchanged; the replan layer must preserve it.
                continue
            task["status"] = "EXCEPTION"
            affected.append(task["task_id"])
        return EventResult(event_id, True, tuple(affected))

    def _dish_added(self, event_id: str, tasks: list[dict[str, Any]]) -> EventResult:
        if not tasks:
            raise EventError("INVALID_EVENT_PAYLOAD", "DISH_ADDED requires at least one task")
        task_ids = [task.get("task_id") for task in tasks]
        if any(not task_id for task_id in task_ids) or len(set(task_ids)) != len(task_ids):
            raise EventError("DUPLICATE_TASK_ID", "DISH_ADDED contains a missing or duplicate task_id")
        if any(task_id in self._tasks for task_id in task_ids):
            raise EventError("DUPLICATE_TASK_ID", "DISH_ADDED contains an existing task_id")

        added = []
        copies = []
        for task, task_id in zip(tasks, task_ids):
            task_copy = deepcopy(task)
            task_copy.setdefault("status", "PENDING")
            task_copy.setdefault("locked", False)
            task_copy.setdefault("notification_points", [])
            copies.append(task_copy)
            added.append(task_id)
        self._schedule["tasks"].extend(copies)
        self._tasks.update(zip(added, copies))
        return EventResult(event_id, True, tuple(added))

    def _task(self, task_id: str) -> dict[str, Any]:
        task = self._tasks.get(task_id)
        if task is None:
            raise EventError("TASK_NOT_FOUND", f"Task {task_id} does not exist")
        return task

    def _assert_mutable(self, task: dict[str, Any]) -> None:
        if task.get("locked") or task.get("status") in LOCKED_STATUSES:
            raise EventError("TASK_LOCKED", f"Task {task['task_id']} cannot be moved")

    def _dependents(self, task_id: str) -> list[str]:
        return [
            task["task_id"]
            for task in self._tasks.values()
            if task.get("predecessors") and task_id in task["predecessors"]
        ]

    @staticmethod
    def _validate_event_shape(event: dict[str, Any]) -> None:
        required = {"event_id", "schedule_id", "event_type", "occurred_at", "payload"}
        missing = required - event.keys()
        if missing:
            raise EventError("INVALID_EVENT", f"Missing event fields: {sorted(missing)}")
        if event["event_type"] not in ALLOWED_EVENTS:
            raise EventError("INVALID_EVENT_TYPE", f"Unsupported event type {event['event_type']}")
        if not isinstance(event["payload"], dict):
            raise EventError("INVALID_EVENT_PAYLOAD", "Event payload must be an object")
