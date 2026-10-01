"""Deterministic CP-SAT baseline scheduler.

The scheduler accepts schema-shaped dictionaries after validation. It deliberately
keeps validation and API concerns outside this module so it can be tested alone.

The objective is lexicographic, matching the V1 hierarchy documented in
`app.metrics.multi_objective.hierarchical_objective`: hard constraints are always
enforced by the model, then finish spread (同出锅时间差), makespan (总时长), and
continuous manual operation are minimised in that order via staged solves. The
third stage models the V1 max-continuous-manual metric exactly (adjacent manual
segments within `manual_merge_gap_sec` merge into one block), so the optimised
quantity and the reported `max_continuous_manual_sec` are the same metric.
"""
from __future__ import annotations

from dataclasses import dataclass
from time import perf_counter
from typing import Any

from ortools.sat.python import cp_model

from app.metrics import finish_spread_sec, max_continuous_manual_sec


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


def _add_continuous_manual_objective(
    model: cp_model.CpModel,
    segments: list[tuple[cp_model.IntVar, int, cp_model.IntVar]],
    merge_gap_sec: int,
    horizon: int,
) -> cp_model.IntVar | None:
    """Model the V1 max-continuous-manual metric exactly and return its variable.

    Each segment is ``(start, duration, end)``. Two segments whose gap is at most
    ``merge_gap_sec`` merge into one continuous block (the V1 contract), and the
    metric is the longest block's span. ``same`` is the transitive closure of the
    pairwise "gap <= merge_gap" relation, so a block's span is bounded by
    ``continuous_manual >= end_j - start_i`` for every same-block pair ``(i, j)``.
    The third solve stage therefore minimises the very quantity the response
    reports, instead of the operator busy span, which is not equivalent.

    Returns ``None`` when there are no segments (the metric is then 0).
    """
    m = len(segments)
    if m == 0:
        return None

    continuous_manual = model.NewIntVar(0, horizon, "continuous_manual")
    # Every segment is a length-1 block on its own.
    for _, duration, _ in segments:
        model.Add(continuous_manual >= duration)

    if m == 1:
        return continuous_manual

    # `link[i][j]` = segment i ends before segment j starts and the gap between
    # them is at most merge_gap_sec (i.e. the merge scan would join them).
    link: dict[tuple[int, int], Any] = {}
    for i in range(m):
        start_i, _, end_i = segments[i]
        for j in range(m):
            if i == j:
                continue
            start_j = segments[j][0]
            before = model.NewBoolVar(f"cm_before_{i}_{j}")
            model.Add(end_i <= start_j).OnlyEnforceIf(before)
            model.Add(end_i >= start_j + 1).OnlyEnforceIf(before.Not())
            gap_ok = model.NewBoolVar(f"cm_gapok_{i}_{j}")
            model.Add(start_j - end_i <= merge_gap_sec).OnlyEnforceIf(gap_ok)
            model.Add(start_j - end_i >= merge_gap_sec + 1).OnlyEnforceIf(gap_ok.Not())
            key = (i, j)
            link[key] = model.NewBoolVar(f"cm_link_{i}_{j}")
            model.Add(link[key] <= before)
            model.Add(link[key] <= gap_ok)
            model.Add(link[key] >= before + gap_ok - 1)

    # `same` is the symmetric transitive closure of `link`: an equivalence
    # relation grouping segments into the blocks the merge scan would produce.
    same: dict[tuple[int, int], Any] = {}
    for i in range(m):
        for j in range(i + 1, m):
            same[(i, j)] = model.NewBoolVar(f"cm_same_{i}_{j}")

    def _same(a: int, b: int) -> Any:
        if a == b:
            return None  # reflexive: always true
        if a > b:
            a, b = b, a
        return same[(a, b)]

    for (i, j), var in same.items():
        model.Add(var >= link[(i, j)])
        model.Add(var >= link[(j, i)])
    for a in range(m):
        for b in range(m):
            if b == a:
                continue
            for c in range(m):
                if c == a or c == b:
                    continue
                model.Add(_same(a, c) >= _same(a, b) + _same(b, c) - 1)

    # A block's span bounds the metric in both directions (either end may be the
    # earlier one); the metric is minimised so it settles on the longest block.
    for (i, j), var in same.items():
        start_i = segments[i][0]
        end_i = segments[i][2]
        start_j = segments[j][0]
        end_j = segments[j][2]
        model.Add(continuous_manual >= end_j - start_i).OnlyEnforceIf(var)
        model.Add(continuous_manual >= end_i - start_j).OnlyEnforceIf(var)

    return continuous_manual


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
    manual_merge_gap_sec = (
        int(objective["manual_merge_gap_sec"]) if objective.get("manual_merge_gap_sec") is not None else 30
    )
    horizon = sum(task["duration_sec"] for task in tasks)
    model = cp_model.CpModel()
    starts: dict[str, cp_model.IntVar] = {}
    ends: dict[str, cp_model.IntVar] = {}
    intervals: dict[str, cp_model.IntervalVar] = {}
    device_choices: dict[str, list[tuple[dict[str, Any], cp_model.BoolVar]]] = {}
    device_intervals: dict[str, list[tuple[cp_model.IntervalVar, int]]] = {}
    operator_intervals: list[tuple[cp_model.IntervalVar, int]] = []
    manual_segments: list[tuple[cp_model.IntVar, int, cp_model.IntVar]] = []

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
            manual_segments.append((manual_start, segment["duration_sec"], manual_end))

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

    # Continuous manual operation (the V1 max-continuous-manual metric). Two
    # manual segments whose gap is at most `manual_merge_gap_sec` merge into one
    # block, and the objective is the longest block's span. This is modelled
    # exactly (see `_add_continuous_manual_objective`) so the third solve stage
    # optimises the same quantity the response reports.
    continuous_manual = _add_continuous_manual_objective(
        model, manual_segments, manual_merge_gap_sec, horizon
    )

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

        # Stage 3: minimise continuous manual operation subject to the pinned
        # spread and makespan. When there are no manual segments the metric is
        # already 0, so there is nothing left to optimise.
        if continuous_manual is not None:
            model.ClearObjective()
            model.Minimize(continuous_manual)
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
        "timings_ms": {"parse": 0, "validation": 0, "solve": elapsed_ms, "notification": 0, "total": elapsed_ms},
        "notifications": [],
    }
