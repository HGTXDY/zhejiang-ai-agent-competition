"""Conservative advance-preparation hints for the product recipe preview.

The V1 task list remains authoritative: no task is removed, shortened, marked
completed or moved in the actual solver by this module. A later scheduling Fix
may use these *hints* to separate advance work from the day-of cooking plan.

Explicit multi-hour cold-storage holds with a recoverable task boundary can
be classified automatically. Vague long holds are flagged for confirmation,
not assigned a made-up number of hours or silently marked finished.
"""
from __future__ import annotations

import re
from typing import Any

# Multi-hour refrigeration/freezing is a useful advance-prep candidate;
# ordinary short cooling, 30-minute resting and multi-hour braising are not.
_ADVANCE_COLD_THRESHOLD_SEC = 3 * 3600
_RELATIVE_HOLD_MIN_SEC = 3600
_ADVANCE_COLD_ACTION = re.compile(r"冷藏|冷冻|冷冻室|冷藏室")
_UNSAFE_HOT_PROCESS = {"stove", "steamer", "oven"}
_HOT_ACTION_IN_SAME_STEP = re.compile(r"煮|炖|炒|炸|煎|焯|烘烤|烘焙|蒸制")
_DURATION_TOKEN = re.compile(r"(?:\d+(?:\.\d+)?\s*(?:个\s*)?(?:小时|分钟|秒|hr|h|min)|半(?:个)?小时)", re.I)
_AMBIGUOUS_ADVANCE = re.compile(r"提前\s*(?:一|1|两|2)?\s*(?:天|日)|隔夜|过夜|前一天")
_LONG_UNCHILLED_HOLD = re.compile(r"腌制|腌渍|浸泡|泡发|醒发|发酵|静置")
# Qualitative length is a *review cue*, never a duration. A later scheduling Fix
# must also consider whether the required hold pushes prep hours before the
# rest of the meal; that depends on a real multi-dish schedule, not this parser.
_VAGUE_LONG = re.compile(r"长时间|较长时间|数小时|几个小时|充分|一整晚|整晚|一夜")


def classify_preparation_phases(tasks: list[dict[str, Any]]) -> dict[str, Any]:
    """Return non-contract display hints while preserving original V1 tasks.

    A safe automatic separation requires a single dependency chain and a long,
    explicit *refrigerator* occupation. Every predecessor through the last such
    hold belongs to advance preparation; all subsequent tasks stay in the main
    cooking stage. We never assume a user has already completed an advance task.
    """
    all_ids = [task["task_id"] for task in tasks]
    if not tasks:
        return {"advance_task_ids": [], "main_task_ids": [], "holds": [], "review_required": []}

    # Parser LLM output may infer a different task graph. Do not invent a phase
    # order when its dependencies are not an explicit linear chain.
    chain = all(task.get("predecessors") == ([all_ids[i - 1]] if i else []) for i, task in enumerate(tasks))
    def unusually_long_for_recipe(index: int, duration_sec: int) -> bool:
        """Only a *hint*: a hold may dominate the rest of one recipe's workflow.

        Actual start-time gaps between recipes require a full schedule and are
        left to the following scheduling Fix, not guessed at parse time.
        """
        if not chain or index >= len(tasks) - 1 or duration_sec < _RELATIVE_HOLD_MIN_SEC:
            return False
        if tasks[index].get("field_status", {}).get("duration_sec") == "defaulted":
            return False
        remaining_sec = sum(task["duration_sec"] for task in tasks[index + 1 :])
        return remaining_sec > 0 and duration_sec >= 2 * remaining_sec

    safe_hold_indices: list[int] = []
    review_required: list[dict[str, Any]] = []
    for index, task in enumerate(tasks):
        text = task["action"]
        duration = task["duration_sec"]
        requirement = task.get("device_requirement") or {}
        cold = requirement.get("device_type") == "refrigerator" and bool(_ADVANCE_COLD_ACTION.search(text))
        long_hold = duration >= _ADVANCE_COLD_THRESHOLD_SEC or unusually_long_for_recipe(index, duration)
        long_cold = cold and long_hold
        if long_cold:
            if (not chain or task.get("manual_duration_sec", 0) > 300
                    or _HOT_ACTION_IN_SAME_STEP.search(text) or len(_DURATION_TOKEN.findall(text)) > 1):
                review_required.append({"task_id": task["task_id"], "reason": "需确认长时间冷藏/冷冻步骤的拆分与先后关系"})
            elif any((prior.get("device_requirement") or {}).get("device_type") in _UNSAFE_HOT_PROCESS for prior in tasks[:index]):
                # Moving cooked food to the previous day needs an explicit
                # food-safety judgement, not just a time optimisation.
                review_required.append({"task_id": task["task_id"], "reason": "冷藏/冷冻前已有加热烹饪，不自动前移"})
            else:
                safe_hold_indices.append(index)
        elif _AMBIGUOUS_ADVANCE.search(text) or (
            _LONG_UNCHILLED_HOLD.search(text) and
            (long_hold or _VAGUE_LONG.search(text))
        ):
            # Explicit multi-hour unchilled marinades and qualitative instructions
            # (e.g. "长时间腌制") may need advance preparation, but without storage
            # conditions or an actual time value we cannot safely schedule them.
            review_required.append({"task_id": task["task_id"], "reason": "可能需要提前准备；请确认处理时长与储存条件"})

    if not safe_hold_indices:
        return {"advance_task_ids": [], "main_task_ids": all_ids, "holds": [], "review_required": review_required}

    # If the prefix has another unresolved long hold, do not label it as a safe
    # cold-storage-only advance plan: it may require distinct timing/handling.
    final = max(safe_hold_indices)
    if any(item["task_id"] in all_ids[: final + 1] for item in review_required):
        return {"advance_task_ids": [], "main_task_ids": all_ids, "holds": [], "review_required": review_required}

    return {
        "advance_task_ids": all_ids[: final + 1],
        "main_task_ids": all_ids[final + 1 :],
        "holds": [
            {"task_id": tasks[index]["task_id"], "duration_sec": tasks[index]["duration_sec"],
             "device_type": "refrigerator", "source_step_index": tasks[index].get("source_step_index")}
            for index in safe_hold_indices
        ],
        "review_required": review_required,
    }
