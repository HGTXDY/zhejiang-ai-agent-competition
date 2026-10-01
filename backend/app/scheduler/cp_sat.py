"""Deterministic CP-SAT baseline scheduler.

The scheduler accepts schema-shaped dictionaries after validation. It deliberately
keeps validation and API concerns outside this module so it can be tested alone.
"""
from __future__ import annotations

from dataclasses import dataclass
from time import perf_counter
from typing import Any

from ortools.sat.python import cp_model


@dataclass(frozen=True)
class SchedulerConfig:
    max_solve_time_sec: int = 5
    seed: int = 0


def _compatible_devices(task: dict[str, Any], devices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    requirement = task.get("device_requirement")
    if requirement is None:
        return []
    result = []
    for device in devices:
        if not device.get("available", True):
            continue
        if device["device_type"] != requirement["device_type"]:
            continue
        mode = requirement.get("mode")
        if mode is not None and mode not in device["capabilities"].get("modes", []):
            continue
        temperature = requirement.get("temperature_c")
        capabilities = device["capabilities"]
        if temperature is not None and (
            (capabilities.get("temperature_min_c") is not None and temperature < capabilities["temperature_min_c"])
            or (capabilities.get("temperature_max_c") is not None and temperature > capabilities["temperature_max_c"])
        ):
            continue
        if device["capacity_units"] < requirement["capacity_units"]:
            continue
        result.append(device)
    return result


def _status_name(status: int) -> str:
    return {
        cp_model.OPTIMAL: "OPTIMAL",
        cp_model.FEASIBLE: "FEASIBLE",
        cp_model.INFEASIBLE: "INFEASIBLE",
        cp_model.UNKNOWN: "UNKNOWN",
    }.get(status, "UNKNOWN")


def _error_response(
    request: dict[str, Any], code: str, message: str, elapsed_ms: int, *, status: str = "INFEASIBLE"
) -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "request_id": request["request_id"],
        "schedule_id": f"{request['request_id']}_schedule",
        "solver": {"status": status, "objective_value": None, "best_bound": None, "gap": None, "duration_ms": elapsed_ms},
        "metrics": {"makespan_sec": 0, "finish_spread_sec": 0, "max_continuous_manual_sec": 0, "device_conflicts": 0, "dependency_violations": 0, "target_delay_sec": 0},
        "tasks": [],
        "validation": {"valid": False, "errors": [{"code": code, "message": message, "path": None}]},
        "timings_ms": {"parse": 0, "validation": 0, "solve": elapsed_ms, "notification": 0, "total": elapsed_ms},
        "notifications": [],
    }


def schedule(
    request: dict[str, Any],
    config: SchedulerConfig | None = None,
    *,
    locked_tasks: dict[str, dict[str, Any]] | None = None,
    start_floors: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Create a V1-shaped schedule from a validated schedule request."""
    config = config or SchedulerConfig()
    started = perf_counter()
    tasks = request["tasks"]
    locked_tasks = locked_tasks or {}
    start_floors = start_floors or {}
    devices = request["device_config"]["devices"]
    horizon = sum(task["duration_sec"] for task in tasks)
    model = cp_model.CpModel()
    starts: dict[str, cp_model.IntVar] = {}
    ends: dict[str, cp_model.IntVar] = {}
    intervals: dict[str, cp_model.IntervalVar] = {}
    device_choices: dict[str, list[tuple[dict[str, Any], cp_model.BoolVar]]] = {}
    device_intervals: dict[str, list[tuple[cp_model.IntervalVar, int]]] = {}
    operator_intervals: list[tuple[cp_model.IntervalVar, int]] = []

    for task in tasks:
        task_id = task["task_id"]
        duration = task["duration_sec"]
        starts[task_id] = model.NewIntVar(0, horizon, f"start_{task_id}")
        ends[task_id] = model.NewIntVar(0, horizon, f"end_{task_id}")
        intervals[task_id] = model.NewIntervalVar(starts[task_id], duration, ends[task_id], f"interval_{task_id}")
        if task_id in start_floors:
            model.Add(starts[task_id] >= start_floors[task_id])
        locked = locked_tasks.get(task_id)
        if locked is not None:
            model.Add(starts[task_id] == locked["start_offset_sec"])
        for predecessor in task["predecessors"]:
            model.Add(starts[task_id] >= ends[predecessor])

        requirement = task.get("device_requirement")
        if requirement:
            candidates = _compatible_devices(task, devices)
            if not candidates:
                elapsed_ms = int((perf_counter() - started) * 1000)
                return _error_response(request, "NO_COMPATIBLE_DEVICE", f"No compatible device for task {task_id}", elapsed_ms)
            choices: list[tuple[dict[str, Any], cp_model.BoolVar]] = []
            for device in candidates:
                selected = model.NewBoolVar(f"assign_{task_id}_{device['device_id']}")
                optional = model.NewOptionalIntervalVar(
                    starts[task_id], duration, ends[task_id], selected, f"device_{task_id}_{device['device_id']}"
                )
                device_intervals.setdefault(device["device_id"], []).append((optional, requirement["capacity_units"]))
                choices.append((device, selected))
            model.AddExactlyOne(selected for _, selected in choices)
            if task_id in locked_tasks:
                assigned = set(locked_tasks[task_id].get("assigned_resources", []))
                matching = [device for device, _ in choices if device["device_id"] in assigned]
                if len(matching) != 1:
                    elapsed_ms = int((perf_counter() - started) * 1000)
                    return _error_response(request, "LOCKED_RESOURCE_INVALID", f"Locked task {task_id} has no compatible assigned device", elapsed_ms)
                for device, selected in choices:
                    model.Add(selected == (device["device_id"] == matching[0]["device_id"]))
            device_choices[task_id] = choices

        segments = task.get("manual_segments", [])
        if task.get("manual_required") and not segments:
            segments = [{"offset_sec": 0, "duration_sec": task["manual_duration_sec"]}]
        for index, segment in enumerate(segments):
            manual_start = model.NewIntVar(0, horizon, f"manual_start_{task_id}_{index}")
            manual_end = model.NewIntVar(0, horizon, f"manual_end_{task_id}_{index}")
            model.Add(manual_start == starts[task_id] + segment["offset_sec"])
            model.Add(manual_end == manual_start + segment["duration_sec"])
            manual_interval = model.NewIntervalVar(
                manual_start, segment["duration_sec"], manual_end, f"manual_{task_id}_{index}"
            )
            operator_intervals.append((manual_interval, 1))

    for device_id, resource_intervals in device_intervals.items():
        device = next(item for item in devices if item["device_id"] == device_id)
        model.AddCumulative(
            [interval for interval, _ in resource_intervals],
            [demand for _, demand in resource_intervals],
            device["capacity_units"],
        )
    if operator_intervals:
        model.AddCumulative(
            [interval for interval, _ in operator_intervals],
            [demand for _, demand in operator_intervals],
            request["device_config"]["operator_count"],
        )

    makespan = model.NewIntVar(0, horizon, "makespan")
    model.AddMaxEquality(makespan, list(ends.values()))
    model.Minimize(makespan)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = config.max_solve_time_sec
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = config.seed
    status = solver.Solve(model)
    elapsed_ms = int((perf_counter() - started) * 1000)
    status_name = _status_name(status)
    if status_name in {"INFEASIBLE", "UNKNOWN"}:
        return _error_response(
            request,
            "SOLVER_TIMEOUT",
            "Solver did not produce a feasible result within the time limit",
            elapsed_ms,
            status="UNKNOWN",
        ) if status_name == "UNKNOWN" else _error_response(
            request, "NO_FEASIBLE_SCHEDULE", "No feasible schedule found", elapsed_ms, status="INFEASIBLE"
        )

    scheduled_tasks = []
    for task in tasks:
        task_id = task["task_id"]
        resources: list[str] = []
        if task_id in device_choices:
            resources.extend(device["device_id"] for device, selected in device_choices[task_id] if solver.Value(selected))
        if task.get("manual_required"):
            resources.append("operator_1")
        scheduled_tasks.append(
            {
                "task_id": task_id,
                "dish_id": task["dish_id"],
                "start_offset_sec": solver.Value(starts[task_id]),
                "end_offset_sec": solver.Value(ends[task_id]),
                "assigned_resources": resources,
                "status": "PENDING",
                "locked": False,
                "notification_points": [],
            }
        )

    dish_ends: dict[str, int] = {}
    for task in scheduled_tasks:
        dish_ends[task["dish_id"]] = max(dish_ends.get(task["dish_id"], 0), task["end_offset_sec"])
    finish_values = list(dish_ends.values())
    finish_spread = max(finish_values) - min(finish_values) if finish_values else 0
    objective = solver.ObjectiveValue()
    bound = solver.BestObjectiveBound()
    return {
        "schema_version": "1.0",
        "request_id": request["request_id"],
        "schedule_id": f"{request['request_id']}_schedule",
        "solver": {"status": status_name, "objective_value": objective, "best_bound": bound, "gap": max(0.0, objective - bound), "duration_ms": elapsed_ms},
        "metrics": {"makespan_sec": solver.Value(makespan), "finish_spread_sec": finish_spread, "max_continuous_manual_sec": 0, "device_conflicts": 0, "dependency_violations": 0, "target_delay_sec": 0},
        "tasks": scheduled_tasks,
        "validation": {"valid": True, "errors": []},
        "timings_ms": {"parse": 0, "validation": 0, "solve": elapsed_ms, "notification": 0, "total": elapsed_ms},
        "notifications": [],
    }
