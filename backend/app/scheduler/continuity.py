"""Very conservative *optional* freshness tie-break for an initial schedule.

Only unmistakable, short manual ingredient preparation immediately preceding an
actual cooking step is eligible. This adds no freshness deadlines and never
shortens recipe durations (including chilling, marinating or proofing).
"""
from __future__ import annotations

import re
from typing import Any

# Do not mistake an ingredient preparation step for a cooking/holding stage.
_PREP = re.compile(r"洗净|清洗|洗切|择菜|切菜|切碎|切片|切丁|切丝|切块|削皮|去皮|剁碎|切段|切末")
_HOLD = re.compile(r"冷藏|冷冻|腌|浸泡|泡发|醒发|发酵|静置|等待|解冻|放凉|隔夜")
_HOLD_OR_COOK = re.compile(r"冷藏|冷冻|腌|浸泡|泡发|醒发|发酵|静置|等待|解冻|放凉|隔夜|焖|炖|煎|炒|煮|蒸|烤|炸|焯|加热")
_COOK = re.compile(r"入锅|下锅|锅中|锅内|翻炒|煎|炒|煮|蒸|烤|炸|焯|炖|焖|烹饪")

# A two-hour gap is not treated as a scheduling error. The threshold only
# triggers a preference; it is NEVER a hard constraint on food storage.
_LARGE_IDLE_SEC = 3 * 3600
_MAX_SHORT_PREP_SEC = 20 * 60


def fresh_prep_edges(tasks: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """Candidate (prep_id, immediate_cooking_id) edges with no intermediate hold.

    Select only a short, manual-only task with *one* direct successor in the same
    dish. Ambiguous multi-successor graphs and unknown/complex steps are not
    modified. If the recipe requires waiting, its original dependencies win.
    """
    task_by_id = {task["task_id"]: task for task in tasks}
    successors: dict[str, list[dict[str, Any]]] = {task_id: [] for task_id in task_by_id}
    for task in tasks:
        for predecessor in task.get("predecessors", []):
            if predecessor in successors:
                successors[predecessor].append(task)

    edges: list[tuple[str, str]] = []
    for prep in tasks:
        text = str(prep.get("action", ""))
        duration = prep.get("duration_sec")
        if not (
            prep.get("resource_type") == "manual"
            and prep.get("manual_required") is True
            and prep.get("device_requirement") is None
            and isinstance(duration, int)
            and not isinstance(duration, bool)
            and 0 < duration <= _MAX_SHORT_PREP_SEC
            and _PREP.search(text)
            and not _HOLD_OR_COOK.search(text)
            and len(successors[prep["task_id"]]) == 1
        ):
            continue

        consumer = successors[prep["task_id"]][0]
        consumer_text = str(consumer.get("action", ""))
        consumer_device = (consumer.get("device_requirement") or {}).get("device_type")
        # No refrigerator or waiting tasks; only direct *cooking* uses. The
        # action may mention e.g. a sauce, but it must actually cook or heat it.
        if (
            consumer.get("dish_id") != prep.get("dish_id")
            or consumer.get("resource_type") == "wait"
            or _HOLD.search(consumer_text)
            or consumer_device not in {"stove", "steamer", "oven"}
            or consumer.get("resource_type") not in {"device", "hybrid"}
            or not _COOK.search(consumer_text)
        ):
            continue
        edges.append((prep["task_id"], consumer["task_id"]))
    return edges


def unusually_idle_edges(
    edges: list[tuple[str, str]], starts: dict[str, Any], ends: dict[str, Any], solver: Any
) -> list[tuple[str, str]]:
    """Only gaps *over three hours* deserve even considering an extra solve."""
    return [(prep, consumer) for prep, consumer in edges
            if solver.Value(starts[consumer]) - solver.Value(ends[prep]) > _LARGE_IDLE_SEC]
