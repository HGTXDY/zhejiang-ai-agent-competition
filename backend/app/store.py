"""In-memory schedule session store for the stateful REST API.

The scheduler and replan service themselves stay stateless (envelope-based); this
store backs the PRD Table 19 stateful endpoints (`GET /schedules/{id}`, event
reporting and notification queries) with a process-local registry. It is
deliberately not persistent: a process restart clears it, which is acceptable for
the single-process demo and evaluation harness and keeps the core services free
of a storage dependency.
"""
from __future__ import annotations

import threading
from copy import deepcopy
from typing import Any


class ScheduleStore:
    """Thread-safe registry mapping schedule_id -> {"request", "schedule"}.

    `get` returns a deep copy so callers cannot corrupt the stored snapshot;
    `replace` atomically publishes the new schedule under both the old and new
    schedule ids so any id in a replan lineage resolves to the latest session.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def put(self, request: dict[str, Any], schedule: dict[str, Any]) -> str:
        schedule_id = schedule["schedule_id"]
        with self._lock:
            self._sessions[schedule_id] = {"request": request, "schedule": schedule}
        return schedule_id

    def get(self, schedule_id: str) -> dict[str, Any] | None:
        with self._lock:
            session = self._sessions.get(schedule_id)
        return deepcopy(session) if session is not None else None

    def replace(self, old_schedule_id: str, request: dict[str, Any], schedule: dict[str, Any]) -> str:
        new_id = schedule["schedule_id"]
        with self._lock:
            session = {"request": request, "schedule": schedule}
            self._sessions[new_id] = session
            if old_schedule_id != new_id:
                self._sessions[old_schedule_id] = session
        return new_id

    def clear(self) -> None:
        with self._lock:
            self._sessions.clear()


store = ScheduleStore()
