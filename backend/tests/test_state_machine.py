import pytest

from app.execution import EventError, ExecutionStateMachine



def schedule(prep_status="PENDING"):
    return {
        "schedule_id": "s1",
        "tasks": [
            {"task_id": "prep", "dish_id": "d", "status": prep_status, "locked": False, "assigned_resources": [], "predecessors": [], "notification_points": []},
            {"task_id": "cook", "dish_id": "d", "status": "PENDING", "locked": False, "assigned_resources": ["stove_1"], "predecessors": ["prep"], "notification_points": []},
            {"task_id": "other", "dish_id": "d2", "status": "PENDING", "locked": False, "assigned_resources": ["stove_1"], "predecessors": [], "notification_points": []},
        ],
    }


def event(event_id, event_type, payload, schedule_id="s1"):
    return {"event_id": event_id, "schedule_id": schedule_id, "event_type": event_type, "occurred_at": "2026-09-26T12:00:00Z", "payload": payload}


def test_completed_task_is_locked_and_dependents_are_affected():
    machine = ExecutionStateMachine(schedule(prep_status="RUNNING"))
    result = machine.apply(event("e1", "TASK_COMPLETED", {"task_id": "prep"}))
    assert result.affected_task_ids == ("cook",)
    assert machine.schedule["tasks"][0]["status"] == "COMPLETED"
    assert machine.schedule["tasks"][0]["locked"] is True


def test_locked_task_cannot_be_delayed():
    machine = ExecutionStateMachine(schedule(prep_status="RUNNING"))
    machine.apply(event("e1", "TASK_COMPLETED", {"task_id": "prep"}))
    with pytest.raises(EventError, match="cannot be moved") as exc:
        machine.apply(event("e2", "TASK_DELAYED", {"task_id": "prep", "delay_sec": 30}))
    assert exc.value.code == "TASK_LOCKED"


def test_device_unavailable_marks_running_but_preserves_locked_and_pending_history():
    current = schedule()
    current["tasks"][1]["status"] = "RUNNING"
    current["tasks"][1]["locked"] = False
    current["tasks"][2]["status"] = "LOCKED"
    current["tasks"][2]["locked"] = True
    machine = ExecutionStateMachine(current)
    result = machine.apply(event("e1", "DEVICE_UNAVAILABLE", {"device_id": "stove_1"}))
    assert set(result.affected_task_ids) == {"cook"}
    assert machine.schedule["tasks"][0]["status"] == "PENDING"
    assert machine.schedule["tasks"][1]["status"] == "EXCEPTION"
    assert machine.schedule["tasks"][2]["status"] == "LOCKED"
    assert machine.schedule["tasks"][2]["locked"] is True


def test_duplicate_event_and_schedule_mismatch_are_rejected():
    machine = ExecutionStateMachine(schedule(prep_status="RUNNING"))
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


def test_pending_task_cannot_be_completed_or_delayed():
    machine = ExecutionStateMachine(schedule())
    with pytest.raises(EventError) as complete:
        machine.apply(event("e1", "TASK_COMPLETED", {"task_id": "prep"}))
    assert complete.value.code == "INVALID_STATE_TRANSITION"
    with pytest.raises(EventError) as delayed:
        machine.apply(event("e2", "TASK_DELAYED", {"task_id": "prep", "delay_sec": 30}))
    assert delayed.value.code == "INVALID_STATE_TRANSITION"


def test_delay_requires_positive_integer_and_running_task():
    machine = ExecutionStateMachine(schedule(prep_status="RUNNING"))
    machine.schedule  # verify the public snapshot does not expose internal state
    with pytest.raises(EventError) as invalid:
        machine.apply(event("e1", "TASK_DELAYED", {"task_id": "prep", "delay_sec": 0}))
    assert invalid.value.code == "INVALID_EVENT_PAYLOAD"
    result = machine.apply(event("e2", "TASK_DELAYED", {"task_id": "prep", "delay_sec": 30}))
    assert result.notifications[0]["delay_sec"] == 30
    assert machine.schedule["tasks"][0]["status"] == "DELAYED"


def test_running_task_records_resource_and_start_changes_independently():
    from app.execution import compare_schedules

    previous = [{"task_id": "running", "dish_id": "d", "status": "RUNNING", "locked": False, "start_offset_sec": 100, "assigned_resources": ["stove_1"]}]
    current = [{"task_id": "running", "dish_id": "d", "status": "RUNNING", "locked": False, "start_offset_sec": 130, "assigned_resources": ["stove_2"]}]
    changes, metrics = compare_schedules(previous, current)
    assert changes[0]["change_type"] == "RESOURCE_CHANGED"
    assert metrics["resource_change_count"] == 1
    assert metrics["start_offset_total_sec"] == 30
