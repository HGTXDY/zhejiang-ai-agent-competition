"""Key-node notification generation for initial and replanned schedules.

Implements FR-501 (关键节点识别) and FR-502 (结构化通知): scheduled tasks are
turned into per-task `notification_points` (start / prepare / manual / complete)
and top-level structured `notifications` (typed `task_due`) that carry the
trigger time, dish, action, device and parameters. Exceptions are surfaced as
`task_delayed` / `device_conflict` by the replan service, which reuses the same
schedule plan so notifications always follow the latest schedule.

The module is deterministic: the same schedule yields the same plan, so it is
testable and does not mutate the structured facts of the schedule.
"""
from __future__ import annotations

from typing import Any, Iterable

PREP_LEAD_SEC = 180
OPERATOR_RESOURCE = "operator_1"


def build_key_node_plan(
    scheduled_tasks: Iterable[dict[str, Any]],
    task_definitions: Iterable[dict[str, Any]],
    *,
    prep_lead_sec: int = PREP_LEAD_SEC,
) -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    """Return (top-level notifications, per-task notification_points).

    Notifications are returned without `created_at`; the caller stamps one
    timestamp for the whole plan so all notifications in a response agree.
    """
    by_id = {task["task_id"]: task for task in task_definitions}
    notifications: list[dict[str, Any]] = []
    points_by_task: dict[str, list[dict[str, Any]]] = {}

    for scheduled in sorted(scheduled_tasks, key=lambda item: item["start_offset_sec"]):
        task_id = scheduled["task_id"]
        definition = by_id.get(task_id)
        if definition is None:
            continue
        # Completed/cancelled tasks are historical: their key-node reminders have
        # already fired, so re-emitting them on every replan floods the reminder
        # feed with stale "现在可以开始" notices for steps that are already done.
        if scheduled.get("status") in {"COMPLETED", "CANCELLED"}:
            continue
        start = scheduled["start_offset_sec"]
        end = scheduled["end_offset_sec"]
        dish_id = scheduled["dish_id"]
        task_action = definition.get("action", "")
        segments = definition.get("manual_segments") or []
        device_id = next(
            (resource for resource in scheduled.get("assigned_resources", []) if resource != OPERATOR_RESOURCE),
            None,
        )
        requirement = definition.get("device_requirement")
        parameters = {
            "node": None,
            "device_type": requirement.get("device_type") if requirement else None,
            "mode": requirement.get("mode") if requirement else None,
            "temperature_c": requirement.get("temperature_c") if requirement else None,
        }

        nodes: list[dict[str, Any]] = []
        if segments:
            # Device/hybrid task with operator hand-off segments.
            for segment in segments:
                seg_start = start + segment["offset_sec"]
                seg_action = segment.get("action") or task_action
                if seg_start > start:
                    prep_offset = max(0, seg_start - prep_lead_sec)
                    lead_min = prep_lead_sec // 60
                    prep_message = f"{lead_min} 分钟后需要：{seg_action}" if lead_min >= 1 else f"即将需要：{seg_action}"
                    nodes.append(
                        {"type": "prepare", "offset_sec": prep_offset, "action": seg_action, "message": prep_message}
                    )
                nodes.append(
                    {"type": "manual", "offset_sec": seg_start, "action": seg_action, "message": f"现在可以开始：{seg_action}"}
                )
            last_segment_end = start + segments[-1]["offset_sec"] + segments[-1]["duration_sec"]
            if end - last_segment_end > 30:
                nodes.append(
                    {"type": "complete", "offset_sec": end, "action": task_action, "message": f"完成：{task_action}，请取出装盘"}
                )
        elif definition.get("manual_required"):
            # Pure manual task: the operator's whole job is the key node.
            nodes.append({"type": "start", "offset_sec": start, "action": task_action, "message": f"现在可以开始：{task_action}"})
            nodes.append({"type": "complete", "offset_sec": end, "action": task_action, "message": f"完成：{task_action}"})
        elif requirement is not None:
            # Pure device tasks still need an end-of-cycle reminder; otherwise
            # unattended steaming/baking/cooling steps silently disappear from
            # both notification surfaces.
            nodes.append({"type": "start", "offset_sec": start, "action": task_action, "message": f"设备开始：{task_action}"})
            nodes.append({"type": "complete", "offset_sec": end, "action": task_action, "message": f"设备完成：{task_action}，请检查并取出"})

        points_by_task[task_id] = [
            {"type": node["type"], "offset_sec": node["offset_sec"], "message": node["message"]} for node in nodes
        ]
        for node in nodes:
            notifications.append(
                {
                    "notification_id": f"{node['type']}-{task_id}-{node['offset_sec']}",
                    "level": "info",
                    "type": "task_due",
                    "trigger_offset_sec": node["offset_sec"],
                    "dish_id": dish_id,
                    "task_id": task_id,
                    "action": node["action"],
                    "device_id": device_id,
                    "parameters": {**parameters, "node": node["type"]},
                    "message": node["message"],
                }
            )

    return notifications, points_by_task
