import pytest

from app.execution import EventError, ExecutionStateMachine



def schedule():
    return {
        "schedule_id": "s1",
        "tasks": [
            {"task_id": "prep", "dish_id": "d", "status": "PENDING", "locked": False, "assigned_resources": [], "predecessors": [], "notification_points": []},
            {"task_id": "cook", "dish_id": "d", "status": "PENDING", "locked": False, "assigned_resources": ["stove_1"], "predecessors": ["prep"], "notification_points": []},
            {"task_id": "other", "dish_id": "d2", "status": "PENDING", "locked": False, "assigned_resources": ["stove_1"], "predecessors": [], "notification_points": []},
        ],
    }


def event(event_id, event_type, payload, schedule_id="s1"):
    return {"event_id": event_id, "schedule_id": schedule_id, "event_type": event_type, "occurred_at": "2026-09-26T12:00:00Z", "payload": payload}


def test_completed_task_is_locked_and_dependents_are_affected():
    machine = ExecutionStateMachine(schedule())
    result = machine.apply(event("e1", "TASK_COMPLETED", {"task_id": "prep"}))
    assert result.affected_task_ids == ("cook",)
    assert machine.schedule["tasks"][0]["status"] == "COMPLETED"
    assert machine.schedule["tasks"][0]["locked"] is True


def test_locked_task_cannot_be_delayed():
    machine = ExecutionStateMachine(schedule())
    machine.apply(event("e1", "TASK_COMPLETED", {"task_id": "prep"}))
    with pytest.raises(EventError, match="cannot be moved") as exc:
        machine.apply(event("e2", "TASK_DELAYED", {"task_id": "prep", "delay_sec": 30}))
    assert exc.value.code == "TASK_LOCKED"


def test_device_unavailable_marks_only_mutable_affected_tasks():
    machine = ExecutionStateMachine(schedule())
    result = machine.apply(event("e1", "DEVICE_UNAVAILABLE", {"device_id": "stove_1"}))
    assert set(result.affected_task_ids) == {"cook", "other"}
    assert all(task["status"] == "EXCEPTION" for task in machine.schedule["tasks"] if task["task_id"] in {"cook", "other"})


def test_duplicate_event_and_schedule_mismatch_are_rejected():
    machine = ExecutionStateMachine(schedule())
    machine.apply(event("e1", "TASK_COMPLETED", {"task_id": "prep"}))
    with pytest.raises(EventError) as duplicate:
        machine.apply(event("e1", "TASK_COMPLETED", {"task_id": "prep"}))
    assert duplicate.value.code == "DUPLICATE_EVENT"
    with pytest.raises(EventError) as mismatch:
        machine.apply(event("e2", "TASK_COMPLETED", {"task_id": "cook"}, schedule_id="other"))
    assert mismatch.value.code == "SCHEDULE_MISMATCH"


def test_dish_added_rejects_duplicate_and_adds_pending_tasks():
    machine = ExecutionStateMachine(schedule())
    new_task = {"task_id": "new", "dish_id": "d3", "predecessors": []}
    result = machine.apply(event("e1", "DISH_ADDED", {"tasks": [new_task]}))
    assert result.affected_task_ids == ("new",)
    assert machine.schedule["tasks"][-1]["status"] == "PENDING"
    with pytest.raises(EventError) as duplicate:
        machine.apply(event("e2", "DISH_ADDED", {"tasks": [new_task]}))
    assert duplicate.value.code == "DUPLICATE_TASK_ID"


def test_schedule_diff_reports_move_resource_change_and_notifications():
    from app.execution import build_notifications, compare_schedules

    previous = [
        {"task_id": "a", "dish_id": "d", "start_offset_sec": 0, "assigned_resources": ["stove_1"], "locked": False},
        {"task_id": "b", "dish_id": "d", "start_offset_sec": 100, "assigned_resources": ["oven_1"], "locked": False},
    ]
    current = [
        {"task_id": "a", "dish_id": "d", "start_offset_sec": 20, "assigned_resources": ["stove_1"], "locked": False},
        {"task_id": "b", "dish_id": "d", "start_offset_sec": 100, "assigned_resources": ["stove_2"], "locked": False},
    ]
    changes, metrics = compare_schedules(previous, current, notified_task_ids={"a", "b"})
    assert [change["change_type"] for change in changes] == ["MOVED", "RESOURCE_CHANGED"]
    assert metrics["start_offset_total_sec"] == 20
    assert metrics["resource_change_count"] == 1
    assert metrics["notified_task_change_count"] == 2
    assert len(build_notifications(changes, created_at="2026-09-26T12:00:00Z")) == 2
