"""Deterministic CP-SAT baseline scheduler.

The scheduler accepts schema-shaped dictionaries after validation. It deliberately
keeps validation and API concerns outside this module so it can be tested alone.

The objective is lexicographic, matching the V1 hierarchy documented in
`app.metrics.multi_objective.hierarchical_objective`: hard constraints are always
enforced by the model, then finish spread (同出锅时间差), makespan (总时长), and
continuous manual operation are minimised in that order via staged solves. The
reported `max_continuous_manual_sec` is the true merge-gap metric from
`app.metrics`, while the third solve stage optimises the operator busy span as a
tractable proxy for continuous manual load.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from time import perf_counter
from typing import Any

from ortools.sat.python import cp_model

from app.metrics import finish_spread_sec, max_continuous_manual_sec
from app.notifications import build_key_node_plan


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
    objective = request.get("objective") or {}
    max_solve_time_sec = float(objective.get("max_solve_time_sec") or config.max_solve_time_sec)
    manual_merge_gap_sec = int(objective.get("manual_merge_gap_sec") or 30)
    horizon = sum(task["duration_sec"] for task in tasks)
    model = cp_model.CpModel()
    starts: dict[str, cp_model.IntVar] = {}
    ends: dict[str, cp_model.IntVar] = {}
    intervals: dict[str, cp_model.IntervalVar] = {}
    device_choices: dict[str, list[tuple[dict[str, Any], cp_model.BoolVar]]] = {}
    device_intervals: dict[str, list[tuple[cp_model.IntervalVar, int]]] = {}
    operator_intervals: list[tuple[cp_model.IntervalVar, int]] = []
    manual_segment_starts: list[cp_model.IntVar] = []
    manual_segment_ends: list[cp_model.IntVar] = []

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
            manual_segment_starts.append(manual_start)
            manual_segment_ends.append(manual_end)

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

    # Dish finish times and finish spread (max dish end - min dish end).
    dish_ids = sorted({task["dish_id"] for task in tasks})
    dish_ends: dict[str, cp_model.IntVar] = {}
    for dish_id in dish_ids:
        dish_ends[dish_id] = model.NewIntVar(0, horizon, f"dish_end_{dish_id}")
        model.AddMaxEquality(
            dish_ends[dish_id], [ends[task["task_id"]] for task in tasks if task["dish_id"] == dish_id]
        )
    finish_spread = model.NewIntVar(0, horizon, "finish_spread")
    max_dish_end = model.NewIntVar(0, horizon, "max_dish_end")
    min_dish_end = model.NewIntVar(0, horizon, "min_dish_end")
    model.AddMaxEquality(max_dish_end, list(dish_ends.values()))
    model.AddMinEquality(min_dish_end, list(dish_ends.values()))
    model.Add(finish_spread == max_dish_end - min_dish_end)

    makespan = model.NewIntVar(0, horizon, "makespan")
    model.AddMaxEquality(makespan, list(ends.values()))

    # Operator busy span (max manual end - min manual start) as the tractable
    # proxy for continuous manual operation.
    max_manual_span = model.NewIntVar(0, horizon, "max_manual_span")
    if manual_segment_starts:
        manual_max_end = model.NewIntVar(0, horizon, "manual_max_end")
        manual_min_start = model.NewIntVar(0, horizon, "manual_min_start")
        model.AddMaxEquality(manual_max_end, manual_segment_ends)
        model.AddMinEquality(manual_min_start, manual_segment_starts)
        model.Add(max_manual_span == manual_max_end - manual_min_start)

    deadline = perf_counter() + max_solve_time_sec

    def solve_stage() -> tuple[cp_model.CpSolver | None, int]:
        solver = cp_model.CpSolver()
        remaining = deadline - perf_counter()
        if remaining <= 0:
            return None, cp_model.UNKNOWN
        solver.parameters.max_time_in_seconds = remaining
        solver.parameters.num_search_workers = 1
        solver.parameters.random_seed = config.seed
        return solver, solver.Solve(model)

    # Stage 1: minimise finish spread (highest-priority soft objective).
    model.Minimize(finish_spread)
    solver, status = solve_stage()
    if solver is None or status == cp_model.UNKNOWN:
        return _error_response(
            request,
            "SOLVER_TIMEOUT",
            "Solver did not produce a feasible result within the time limit",
            int((perf_counter() - started) * 1000),
            status="UNKNOWN",
        )
    if status == cp_model.INFEASIBLE:
        return _error_response(request, "NO_FEASIBLE_SCHEDULE", "No feasible schedule found", int((perf_counter() - started) * 1000))
    model.Add(finish_spread <= solver.Value(finish_spread))
    final_solver = solver
    all_optimal = status == cp_model.OPTIMAL
    makespan_bound: int | None = None

    # Stage 2: minimise makespan subject to the pinned finish spread.
    model.ClearObjective()
    model.Minimize(makespan)
    solver, status = solve_stage()
    if solver is not None and status not in {cp_model.INFEASIBLE, cp_model.UNKNOWN}:
        model.Add(makespan <= solver.Value(makespan))
        makespan_bound = solver.BestObjectiveBound()
        final_solver = solver
        all_optimal = all_optimal and status == cp_model.OPTIMAL

        # Stage 3: minimise operator busy span subject to the pinned spread and makespan.
        model.ClearObjective()
        model.Minimize(max_manual_span)
        solver, status = solve_stage()
        if solver is not None and status not in {cp_model.INFEASIBLE, cp_model.UNKNOWN}:
            final_solver = solver
            all_optimal = all_optimal and status == cp_model.OPTIMAL
        else:
            all_optimal = False
    else:
        all_optimal = False

    elapsed_ms = int((perf_counter() - started) * 1000)
    status_name = "OPTIMAL" if all_optimal else "FEASIBLE"

    scheduled_tasks = []
    for task in tasks:
        task_id = task["task_id"]
        resources: list[str] = []
        if task_id in device_choices:
            resources.extend(device["device_id"] for device, selected in device_choices[task_id] if final_solver.Value(selected))
        if task.get("manual_required"):
            resources.append("operator_1")
        scheduled_tasks.append(
            {
                "task_id": task_id,
                "dish_id": task["dish_id"],
                "start_offset_sec": final_solver.Value(starts[task_id]),
                "end_offset_sec": final_solver.Value(ends[task_id]),
                "assigned_resources": resources,
                "status": "PENDING",
                "locked": False,
                "notification_points": [],
            }
        )

    finish_spread_value = finish_spread_sec(scheduled_tasks)
    max_continuous_manual_value = max_continuous_manual_sec(
        scheduled_tasks, tasks, merge_gap_sec=manual_merge_gap_sec
    )
    objective_value = final_solver.Value(makespan)
    gap = max(0.0, objective_value - makespan_bound) if makespan_bound is not None else None

    notification_started = perf_counter()
    notifications, points_by_task = build_key_node_plan(scheduled_tasks, tasks)
    created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for notification in notifications:
        notification["created_at"] = created_at
    for scheduled_task in scheduled_tasks:
        scheduled_task["notification_points"] = points_by_task.get(scheduled_task["task_id"], [])
    notification_ms = int((perf_counter() - notification_started) * 1000)

    return {
        "schema_version": "1.0",
        "request_id": request["request_id"],
        "schedule_id": f"{request['request_id']}_schedule",
        "solver": {
            "status": status_name,
            "objective_value": objective_value,
            "best_bound": makespan_bound,
            "gap": gap,
            "duration_ms": elapsed_ms,
        },
        "metrics": {
            "makespan_sec": objective_value,
            "finish_spread_sec": finish_spread_value,
            "max_continuous_manual_sec": max_continuous_manual_value,
            "device_conflicts": 0,
            "dependency_violations": 0,
            "target_delay_sec": 0,
        },
        "tasks": scheduled_tasks,
        "validation": {"valid": True, "errors": []},
        "timings_ms": {"parse": 0, "validation": 0, "solve": elapsed_ms, "notification": notification_ms, "total": elapsed_ms + notification_ms},
        "notifications": notifications,
    }
