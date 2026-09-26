"""Pure metrics and lexicographic objective primitives for schedule optimization.

This module deliberately has no OR-Tools dependency. It can be used by the
scheduler, replan evaluator, API and reports without duplicating metric logic.
All relative times are integer seconds.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Iterable

DEFAULT_MANUAL_MERGE_GAP_SEC = 30


def finish_spread_sec(scheduled_tasks: Iterable[dict[str, Any]]) -> int:
    """Return the difference between the latest and earliest dish finish time."""
    dish_ends: dict[str, int] = {}
    for task in scheduled_tasks:
        dish_id = task["dish_id"]
        dish_ends[dish_id] = max(dish_ends.get(dish_id, 0), task["end_offset_sec"])
    if len(dish_ends) < 2:
        return 0
    values = dish_ends.values()
    return max(values) - min(values)


def serial_baseline_makespan_sec(tasks: Iterable[dict[str, Any]]) -> int:
    """Return the sequential baseline by summing task durations."""
    return sum(task["duration_sec"] for task in tasks)


def max_continuous_manual_sec(
    scheduled_tasks: Iterable[dict[str, Any]],
    task_definitions: Iterable[dict[str, Any]],
    *,
    merge_gap_sec: int = DEFAULT_MANUAL_MERGE_GAP_SEC,
) -> int:
    """Return the longest merged manual-operation interval.

    `scheduled_tasks` supplies each task's start offset. `task_definitions`
    supplies `manual_segments`; when a task is manual but has no segments, its
    `manual_duration_sec` is treated as an interval from task start. A gap at
    most `merge_gap_sec` is merged according to the V1 contract.
    """
    if merge_gap_sec < 0:
        raise ValueError("merge_gap_sec must be non-negative")
    definitions = {task["task_id"]: task for task in task_definitions}
    intervals_by_operator: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for scheduled in scheduled_tasks:
        definition = definitions.get(scheduled["task_id"])
        if not definition or not definition.get("manual_required"):
            continue
        segments = definition.get("manual_segments") or [
            {"offset_sec": 0, "duration_sec": definition["manual_duration_sec"]}
        ]
        for segment in segments:
            start = scheduled["start_offset_sec"] + segment["offset_sec"]
            end = start + segment["duration_sec"]
            if end <= start:
                continue
            operator_id = scheduled.get("manual_resource_id", "operator_1")
            intervals_by_operator[operator_id].append((start, end))

    longest = 0
    for intervals in intervals_by_operator.values():
        intervals.sort()
        merged_start, merged_end = intervals[0]
        for start, end in intervals[1:]:
            if start - merged_end <= merge_gap_sec:
                merged_end = max(merged_end, end)
            else:
                longest = max(longest, merged_end - merged_start)
                merged_start, merged_end = start, end
        longest = max(longest, merged_end - merged_start)
    return longest


def hierarchical_objective(
    *,
    hard_constraint_violations: int,
    finish_spread: int,
    makespan: int,
    max_continuous_manual: int,
) -> tuple[int, int, int, int]:
    """Return the V1 lexicographic minimization vector.

    Hard constraint violations are always first. The remaining objectives are
    ordered as finish spread, makespan, and continuous manual operation. A
    solver integration may use this vector in staged solves or an equivalent
    provably lexicographic formulation.
    """
    if hard_constraint_violations < 0:
        raise ValueError("hard_constraint_violations must be non-negative")
    return (
        hard_constraint_violations,
        finish_spread,
        makespan,
        max_continuous_manual,
    )
