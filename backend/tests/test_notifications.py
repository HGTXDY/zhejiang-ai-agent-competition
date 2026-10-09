import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

from app.notifications import build_key_node_plan
from app.scheduler import schedule

ROOT = Path(__file__).resolve().parents[2]

NOTIFICATION_VALIDATOR = Draft202012Validator(
    json.loads((ROOT / "contracts" / "v1" / "schemas" / "notification.schema.json").read_text(encoding="utf-8")),
    format_checker=FormatChecker(),
)
POINT_TYPES = {"start", "prepare", "manual", "complete", "exception"}


def load_fixture(name: str) -> dict:
    return json.loads((ROOT / "fixtures" / "v1" / name).read_text(encoding="utf-8"))


def test_schedule_returns_schema_valid_notifications() -> None:
    result = schedule(load_fixture("four-dish-normal.json"))
    assert result["solver"]["status"] in {"OPTIMAL", "FEASIBLE"}
    assert result["notifications"], "initial schedule must emit key-node notifications"
    for notification in result["notifications"]:
        assert list(NOTIFICATION_VALIDATOR.iter_errors(notification)) == []
        assert notification["type"] == "task_due"
        assert notification["parameters"]["node"] in POINT_TYPES


def test_every_task_carries_notification_points() -> None:
    request = load_fixture("four-dish-normal.json")
    result = schedule(request)
    by_id = {task["task_id"]: task for task in result["tasks"]}
    for task in request["tasks"]:
        points = by_id[task["task_id"]]["notification_points"]
        assert points, f"{task['task_id']} is missing notification_points"
        for point in points:
            assert point["type"] in POINT_TYPES
            assert point["offset_sec"] >= 0
            assert 1 <= len(point["message"]) <= 500


def test_pure_manual_task_gets_start_and_complete_nodes() -> None:
    result = schedule(load_fixture("four-dish-normal.json"))
    by_id = {task["task_id"]: task for task in result["tasks"]}
    ribs_prepare = by_id["ribs_prepare"]  # resource_type=manual, no manual_segments
    kinds = {point["type"] for point in ribs_prepare["notification_points"]}
    assert kinds == {"start", "complete"}
    offsets = {point["type"]: point["offset_sec"] for point in ribs_prepare["notification_points"]}
    assert offsets["start"] == ribs_prepare["start_offset_sec"]
    assert offsets["complete"] == ribs_prepare["end_offset_sec"]


def test_hybrid_task_gets_manual_intervention_at_segment_offset() -> None:
    request = load_fixture("four-dish-normal.json")
    result = schedule(request)
    by_id = {task["task_id"]: task for task in result["tasks"]}
    ribs_blanch = by_id["ribs_blanch"]  # hybrid: two manual segments (放入/捞出)
    kinds = {point["type"] for point in ribs_blanch["notification_points"]}
    assert "manual" in kinds
    manual_points = [p for p in ribs_blanch["notification_points"] if p["type"] == "manual"]
    definition = next(t for t in request["tasks"] if t["task_id"] == "ribs_blanch")
    expected = {
        ribs_blanch["start_offset_sec"] + segment["offset_sec"]
        for segment in definition["manual_segments"]
    }
    assert {p["offset_sec"] for p in manual_points} == expected


def test_key_node_plan_is_deterministic() -> None:
    request = load_fixture("four-dish-normal.json")
    first = schedule(request)
    second = schedule(request)

    def strip(notifications: list[dict]) -> list[dict]:
        return [{k: v for k, v in n.items() if k != "created_at"} for n in notifications]

    assert strip(first["notifications"]) == strip(second["notifications"])
    assert [t["notification_points"] for t in first["tasks"]] == [
        t["notification_points"] for t in second["tasks"]
    ]


def test_build_key_node_plan_matches_task_definitions_directly() -> None:
    request = load_fixture("four-dish-normal.json")
    result = schedule(request)
    notifications, points = build_key_node_plan(result["tasks"], request["tasks"])
    # build_key_node_plan is the source of truth for both surfaces.
    by_task = {task["task_id"]: task for task in result["tasks"]}
    for task_id, expected_points in points.items():
        assert by_task[task_id]["notification_points"] == expected_points
    assert {n["notification_id"] for n in notifications} == {
        n["notification_id"] for n in result["notifications"]
    }



def test_pure_device_task_gets_start_and_complete_notifications() -> None:
    scheduled = [{
        "task_id": "steam_only", "dish_id": "dish", "start_offset_sec": 120,
        "end_offset_sec": 600, "assigned_resources": ["steamer_1"],
        "status": "PENDING", "locked": False, "notification_points": [],
    }]
    definitions = [{
        "task_id": "steam_only", "dish_id": "dish", "action": "普通蒸 8 分钟",
        "device_requirement": {"device_type": "steamer", "mode": "steam", "capacity_units": 1},
        "manual_required": False, "manual_segments": [],
    }]
    notifications, points = build_key_node_plan(scheduled, definitions)
    assert {point["type"] for point in points["steam_only"]} == {"start", "complete"}
    assert {point["offset_sec"] for point in points["steam_only"]} == {120, 600}
    assert {notification["trigger_offset_sec"] for notification in notifications} == {120, 600}
    assert all(notification["device_id"] == "steamer_1" for notification in notifications)


def test_completed_tasks_are_excluded_from_key_node_plan() -> None:
    scheduled = [
        {
            "task_id": "done_task", "dish_id": "dish", "start_offset_sec": 0,
            "end_offset_sec": 300, "assigned_resources": ["operator_1"],
            "status": "COMPLETED", "locked": True, "notification_points": [],
        },
        {
            "task_id": "todo_task", "dish_id": "dish", "start_offset_sec": 300,
            "end_offset_sec": 600, "assigned_resources": ["operator_1"],
            "status": "PENDING", "locked": False, "notification_points": [],
        },
    ]
    definitions = [
        {"task_id": "done_task", "dish_id": "dish", "action": "已经完成", "manual_required": True, "manual_segments": []},
        {"task_id": "todo_task", "dish_id": "dish", "action": "还没做", "manual_required": True, "manual_segments": []},
    ]
    notifications, points = build_key_node_plan(scheduled, definitions)
    # Completed tasks are historical: their reminders already fired and must not
    # be re-emitted on every replan, or the reminder feed shows stale "现在可以开始"
    # notices for steps that are already done.
    assert {notification["task_id"] for notification in notifications} == {"todo_task"}
    assert set(points) == {"todo_task"}
