"""Opt-in, two-stage *product* planning for recipes with advance cold holds.

The official /v1/schedules contract, CP-SAT objective and event/replan semantics
are unchanged. A confirmed advance phase is a user assertion, never an inferred
COMPLETED task. Before confirmation the main plan is a preview, not executable.

Both stages are solved independently and are executed sequentially; their
resources can therefore never overlap. V1 dependencies crossing the boundary
are fulfilled only by the explicit confirmation gate. This module does not
change official source recipes or shorten any task duration.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta
from hashlib import sha256
from typing import Any, Callable

from app.preparation_phases import classify_preparation_phases


@dataclass(frozen=True)
class StagedPartition:
    advance_request: dict[str, Any] | None
    main_request: dict[str, Any]
    advance_task_ids: tuple[str, ...]
    review_required: tuple[dict[str, Any], ...]


def _child_request_id(original: str, suffix: str) -> str:
    candidate = f"{original}_{suffix}"
    if len(candidate) <= 64:
        return candidate
    return f"{original[:45]}_{sha256(original.encode()).hexdigest()[:12]}_{suffix}"


def partition_staged_request(request: dict[str, Any]) -> StagedPartition:
    """Extract only proven linear, safe advance prefixes, preserving all tasks.

    Tasks are grouped by dish (not their global interleaving order). Every task
    appears in exactly one stage. A dependency from advance -> main is removed
    from the main *planning* copy only, never from the original request; that
    dependency is discharged solely by the explicit confirmation of all
    advance tasks. A dependency from main -> advance forbids the split.
    """
    by_dish: dict[str, list[dict[str, Any]]] = {}
    for task in request["tasks"]:
        by_dish.setdefault(task["dish_id"], []).append(task)

    advance_ids: set[str] = set()
    reviews: list[dict[str, Any]] = []
    for group in by_dish.values():
        phase = classify_preparation_phases(group)
        reviews.extend(phase["review_required"])
        # A dish consisting entirely of advance work is not a complete main
        # course: leave it untouched until the recipe can be resolved.
        if phase["advance_task_ids"] and not phase["main_task_ids"]:
            reviews.append({"task_id": group[-1]["task_id"], "reason": "提前准备后缺少正式烹饪步骤，请核对菜谱"})
            continue
        advance_ids.update(phase["advance_task_ids"])

    # Do not split non-linear/inter-dish graphs with reverse dependencies.
    for task in request["tasks"]:
        if task["task_id"] in advance_ids and any(pred not in advance_ids for pred in task["predecessors"]):
            reviews.append({"task_id": task["task_id"], "reason": "提前步骤依赖正式烹饪任务，不能安全分区"})
            advance_ids.clear()
            break

    # Preserve source order (used by the renderer and deterministic tests).
    advance = [deepcopy(task) for task in request["tasks"] if task["task_id"] in advance_ids]
    main = [deepcopy(task) for task in request["tasks"] if task["task_id"] not in advance_ids]
    original_ids = {task["task_id"] for task in request["tasks"]}
    assert {t["task_id"] for t in advance + main} == original_ids
    # Cross-phase predecessors are removed ONLY from the derived main request,
    # which is blocked until the user confirms all advance work.
    for task in main:
        task["predecessors"] = [pred for pred in task["predecessors"] if pred not in advance_ids]

    def child(which: str, subset: list[dict[str, Any]]) -> dict[str, Any]:
        result = deepcopy(request)
        result["request_id"] = _child_request_id(request["request_id"], which)
        result["tasks"] = subset
        return result

    return StagedPartition(
        advance_request=child("advance", advance) if advance else None,
        main_request=child("main", main) if advance else deepcopy(request),
        advance_task_ids=tuple(t["task_id"] for t in advance),
        review_required=tuple(reviews),
    )


def _stage_timing(request: dict[str, Any], advance_sec: int, main_sec: int) -> dict[str, Any]:
    target_str = request["device_config"].get("target_ready_at")
    main_start = None
    advance_start = None
    if target_str is not None:
        target = datetime.fromisoformat(target_str.replace("Z", "+00:00"))
        if target.tzinfo is None:
            raise ValueError("target_ready_at must include a timezone")
        main_start = target - timedelta(seconds=main_sec)
        advance_start = main_start - timedelta(seconds=advance_sec)
    # The phases are deliberately scheduled one after the other. Their
    # makespans already account for parallel tasks *within* each phase, so
    # the full wall-clock span is the sum of both phase makespans, not the
    # sum of individual task durations. Crucially, the advance hold (e.g.
    # a 24-hour freeze) remains part of this full elapsed time.
    total_sec = advance_sec + main_sec
    return {
        "target_ready_at": target_str,
        "suggested_advance_start_at": advance_start.isoformat() if advance_start and advance_sec else None,
        "advance_finish_by": main_start.isoformat() if main_start and advance_sec else None,
        "suggested_main_start_at": main_start.isoformat() if main_start else None,
        "advance_makespan_sec": advance_sec,
        "main_makespan_sec": main_sec,
        "total_elapsed_sec": total_sec,
        # Phase offsets share one elapsed-time axis beginning at the planned
        # start of advance preparation; used later to draw a split Gantt
        # without distorting real task lengths or hiding multi-day holds.
        "advance_start_offset_sec": 0,
        "main_start_offset_sec": advance_sec,
        "total_finish_offset_sec": total_sec,
        # These are suggested plan times, not a claim that any work was done.
    }


def build_staged_plan(
    request: dict[str, Any],
    confirmed_advance_task_ids: list[str],
    solve: Callable[[dict[str, Any]], dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Return staged preview and (only when permitted) executable main request.

    The caller validates the original request and confirmations before calling.
    A failed stage solve aborts the whole operation; nothing is stored. The
    official solver remains responsible for all hard constraints and objective
    quality inside each phase.
    """
    partition = partition_staged_request(request)
    advance_set = set(partition.advance_task_ids)
    confirmed = set(confirmed_advance_task_ids)
    if confirmed - advance_set:
        raise ValueError("Confirmed task IDs contain tasks outside the advance plan")
    if len(confirmed) != len(confirmed_advance_task_ids):
        raise ValueError("Confirmed task IDs must be unique")

    advanced_result = solve(partition.advance_request) if partition.advance_request else None
    main_result = solve(partition.main_request)
    for stage, result in (("advance", advanced_result), ("main", main_result)):
        if result is not None and (result["solver"]["status"] not in {"OPTIMAL", "FEASIBLE"}
                                   or not result["validation"]["valid"]):
            raise StagedSolveError(stage, result)

    required = list(partition.advance_task_ids)
    pending = [task_id for task_id in required if task_id not in confirmed]
    review = list(partition.review_required)
    ready = not pending and not review
    status = "NEEDS_REVIEW" if review else ("PREPARATION_REQUIRED" if pending else "READY")
    advance_makespan = advanced_result["metrics"]["makespan_sec"] if advanced_result else 0
    main_makespan = main_result["metrics"]["makespan_sec"]
    result = {
        "schema_version": "1.0",
        "request_id": request["request_id"],
        "status": status,
        "can_start_main": ready,
        "advance_task_ids": required,
        "pending_advance_task_ids": pending,
        "review_required": review,
        "advance_schedule": advanced_result,
        "main_schedule": main_result,  # PREVIEW until all advance tasks confirmed.
        "executable_main_request": partition.main_request if ready else None,
        "timing": _stage_timing(request, advance_makespan, main_makespan),
    }
    return result, partition.main_request if ready else None


class StagedSolveError(Exception):
    def __init__(self, stage: str, result: dict[str, Any]):
        self.stage = stage
        self.result = result
        super().__init__(f"{stage} stage solver returned {result['solver']['status']}")
