"""Replan diff and notification primitives for V1 responses."""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Iterable


def compare_schedules(
    previous_tasks: Iterable[dict[str, Any]],
    new_tasks: Iterable[dict[str, Any]],
    *,
    notified_task_ids: set[str] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Compare task schedules and calculate V1 disruption metrics.

    Locked tasks are reported as `LOCKED` even if a bad candidate schedule
    attempts to move them; the replan service should reject that candidate
    before returning it to clients.
    """
    old = {task["task_id"]: task for task in previous_tasks}
    new = {task["task_id"]: task for task in new_tasks}
    changes: list[dict[str, Any]] = []
    notified_task_ids = notified_task_ids or set()
    start_offset_total = resource_changes = notified_changes = 0

    for task_id in sorted(set(old) | set(new)):
        before, after = old.get(task_id), new.get(task_id)
        if before is None:
            change_type = "ADDED"
        elif after is None:
            change_type = "REMOVED"
        else:
            resources_changed = before.get("assigned_resources", []) != after.get("assigned_resources", [])
            start_changed = before.get("start_offset_sec") != after.get("start_offset_sec")
            truly_locked = before.get("locked") or before.get("status") in {"COMPLETED", "LOCKED"}
            if truly_locked:
                # A completed/explicitly locked task must never be changed by a
                # candidate schedule; the replan service rejects that candidate.
                change_type = "LOCKED"
            else:
                if resources_changed:
                    resource_changes += 1
                if start_changed:
                    start_offset_total += abs(after["start_offset_sec"] - before["start_offset_sec"])
                if resources_changed:
                    change_type = "RESOURCE_CHANGED"
                elif start_changed:
                    change_type = "MOVED"
                elif before.get("status") == "RUNNING":
                    # A running task with identical placement was preserved.
                    change_type = "LOCKED"
                else:
                    change_type = "UNCHANGED"
        if change_type not in {"UNCHANGED", "LOCKED"} and task_id in notified_task_ids:
            notified_changes += 1
        changes.append(
            {
                "task_id": task_id,
                "change_type": change_type,
                "old_start_offset_sec": before.get("start_offset_sec") if before else None,
                "new_start_offset_sec": after.get("start_offset_sec") if after else None,
                "old_resources": before.get("assigned_resources", []) if before else [],
                "new_resources": after.get("assigned_resources", []) if after else [],
            }
        )

    return changes, {
        "start_offset_total_sec": start_offset_total,
        "resource_change_count": resource_changes,
        "order_change_count": _order_change_count(old, new),
        "notified_task_change_count": notified_changes,
    }


def _order_change_count(old: dict[str, dict[str, Any]], new: dict[str, dict[str, Any]]) -> int:
    old_orders = _orders(old)
    new_orders = _orders(new)
    return sum(
        1
        for dish_id in set(old_orders) & set(new_orders)
        if old_orders[dish_id] != new_orders[dish_id]
    )


def _orders(tasks: dict[str, dict[str, Any]]) -> dict[str, list[str]]:
    grouped: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for task_id, task in tasks.items():
        grouped[task["dish_id"]].append((task.get("start_offset_sec", 0), task_id))
    return {dish: [task_id for _, task_id in sorted(values)] for dish, values in grouped.items()}


def _relative_delta(old_start: int | None, new_start: int | None) -> str:
    """Humanise a start-offset change as a relative-time phrase, or '' if none."""
    if old_start is None or new_start is None or old_start == new_start:
        return ""
    delta = new_start - old_start
    minutes = abs(delta) // 60
    if minutes == 0:
        return "提前 1 分钟以内" if delta < 0 else "推迟 1 分钟以内"
    return f"提前 {minutes} 分钟" if delta < 0 else f"推迟 {minutes} 分钟"


def build_notifications(
    changes: Iterable[dict[str, Any]],
    *,
    created_at: str,
    task_meta: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Build contract-shaped schedule update notifications for changed tasks.

    ``task_meta`` maps task_id to its request definition (for ``action`` and
    ``dish_id``) so notifications read as an actionable instruction with a dish,
    rather than the generic "task X changed" placeholder.
    """
    task_meta = task_meta or {}
    notifications = []
    for change in changes:
        kind = change["change_type"]
        if kind in {"UNCHANGED", "LOCKED"}:
            continue
        meta = task_meta.get(change["task_id"], {})
        action = meta.get("action") or change["task_id"]
        dish_id = meta.get("dish_id")
        if kind == "MOVED":
            relative = _relative_delta(change["old_start_offset_sec"], change["new_start_offset_sec"])
            message = f"{action}：{relative}，请按新时间执行。" if relative else f"{action}：排程时间已调整，请按新时间执行。"
        elif kind == "RESOURCE_CHANGED":
            resources = "、".join(change["new_resources"]) or "待分配设备"
            message = f"{action}：改用 {resources}。"
        elif kind == "ADDED":
            message = f"新增任务：{action}，请留意新增步骤。"
        elif kind == "REMOVED":
            message = f"任务已取消：{action}。"
        else:
            message = f"{action} 的排程发生变化，请确认。"
        notifications.append(
            {
                "notification_id": f"schedule-updated-{change['task_id']}",
                "level": "warning" if kind in {"MOVED", "RESOURCE_CHANGED"} else "info",
                "type": "schedule_updated",
                "trigger_offset_sec": change["new_start_offset_sec"] or 0,
                "dish_id": dish_id,
                "task_id": change["task_id"],
                "action": action,
                "device_id": (change["new_resources"] or [None])[0],
                "parameters": {"change_type": kind},
                "message": message,
                "created_at": created_at,
            }
        )
    return notifications
