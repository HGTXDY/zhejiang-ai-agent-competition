import copy
import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.api import app
from app.replan import REGISTRY, SCHEMAS
from jsonschema import Draft202012Validator
from app.scheduler import schedule

ROOT = Path(__file__).resolve().parents[2]
client = TestClient(app)


def fixture_request() -> dict:
    return json.loads((ROOT / "fixtures" / "v1" / "four-dish-normal.json").read_text(encoding="utf-8"))


def current_schedule() -> tuple[dict, dict]:
    request = fixture_request()
    response = schedule(request)
    response["tasks"][0]["status"] = "RUNNING"
    response["tasks"][1]["status"] = "PENDING"
    return request, response


def event(event_id: str, schedule_id: str, event_type: str, payload: dict) -> dict:
    return {
        "schema_version": "1.0",
        "event_id": event_id,
        "schedule_id": schedule_id,
        "event_type": event_type,
        "occurred_at": "2026-09-27T12:00:00Z",
        "payload": payload,
    }


def test_replan_completes_running_task_and_locks_it():
    request, previous = current_schedule()
    body = {
        "event": event("event-complete-1", previous["schedule_id"], "TASK_COMPLETED", {"task_id": previous["tasks"][0]["task_id"]}),
        "schedule_request": request,
        "current_schedule": previous,
    }
    response = client.post("/v1/replans", json=body)
    assert response.status_code == 200
    result = response.json()
    assert result["previous_schedule_id"] == previous["schedule_id"]
    locked = next(task for task in result["schedule"]["tasks"] if task["task_id"] == previous["tasks"][0]["task_id"])
    assert locked["status"] == "COMPLETED"
    assert locked["locked"] is True
    assert result["disruption_metrics"]["notified_task_change_count"] >= 0


def test_replan_rejects_pending_completion_without_scheduling():
    request = fixture_request()
    previous = schedule(request)
    body = {
        "event": event("event-invalid-1", previous["schedule_id"], "TASK_COMPLETED", {"task_id": previous["tasks"][0]["task_id"]}),
        "schedule_request": request,
        "current_schedule": previous,
    }
    response = client.post("/v1/replans", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_STATE_TRANSITION"


def test_replan_rejects_schedule_mismatch():
    request, previous = current_schedule()
    body = {
        "event": event("event-mismatch-1", "other-schedule", "TASK_COMPLETED", {"task_id": previous["tasks"][0]["task_id"]}),
        "schedule_request": request,
        "current_schedule": previous,
    }
    response = client.post("/v1/replans", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SCHEDULE_MISMATCH"


def test_replan_response_matches_contract():
    request, previous = current_schedule()
    body = {
        "event": event("event-contract-1", previous["schedule_id"], "TASK_COMPLETED", {"task_id": previous["tasks"][0]["task_id"]}),
        "schedule_request": request,
        "current_schedule": previous,
    }
    response = client.post("/v1/replans", json=body)
    assert response.status_code == 200
    validator = Draft202012Validator(SCHEMAS["replan-response.schema.json"], registry=REGISTRY)
    assert list(validator.iter_errors(response.json())) == []


def test_replan_delay_moves_mutable_task_after_delay_floor():
    request, previous = current_schedule()
    task_id = previous["tasks"][0]["task_id"]
    old_start = previous["tasks"][0]["start_offset_sec"]
    body = {
        "event": event("event-delay-1", previous["schedule_id"], "TASK_DELAYED", {"task_id": task_id, "delay_sec": 30}),
        "schedule_request": request,
        "current_schedule": previous,
    }
    response = client.post("/v1/replans", json=body)
    assert response.status_code == 200
    changed = next(task for task in response.json()["schedule"]["tasks"] if task["task_id"] == task_id)
    assert changed["status"] == "DELAYED"
    assert changed["start_offset_sec"] >= old_start + 30


def test_replan_rejects_unknown_device_event():
    request, previous = current_schedule()
    body = {
        "event": event("event-unknown-device-1", previous["schedule_id"], "DEVICE_UNAVAILABLE", {"device_id": "stove-does-not-exist"}),
        "schedule_request": request,
        "current_schedule": previous,
    }
    response = client.post("/v1/replans", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "UNKNOWN_DEVICE"


def test_replan_marks_running_tasks_on_unavailable_device_and_preserves_pending_history():
    request, previous = current_schedule()
    configured_ids = {device["device_id"] for device in request["device_config"]["devices"]}
    assigned = next(task for task in previous["tasks"] if configured_ids.intersection(task.get("assigned_resources", [])))
    assigned["status"] = "RUNNING"
    device_id = next(device["device_id"] for device in request["device_config"]["devices"] if device["device_id"] in assigned["assigned_resources"])
    body = {
        "event": event("event-device-1", previous["schedule_id"], "DEVICE_UNAVAILABLE", {"device_id": device_id}),
        "schedule_request": request,
        "current_schedule": previous,
    }
    response = client.post("/v1/replans", json=body)
    assert response.status_code == 200
    result = response.json()
    updated = {task["task_id"]: task for task in result["schedule"]["tasks"]}
    assert updated[assigned["task_id"]]["status"] == "EXCEPTION"
    assert any(change["task_id"] == assigned["task_id"] for change in result["changes"])


def test_replan_adds_dish_and_returns_added_task_change():
    request, previous = current_schedule()
    new_task = dict(request["tasks"][0])
    new_task["task_id"] = "added-task-1"
    new_task["dish_id"] = "dish-added"
    new_task["action"] = "临时加菜"
    body = {
        "event": event("event-add-1", previous["schedule_id"], "DISH_ADDED", {"tasks": [new_task]}),
        "schedule_request": request,
        "current_schedule": previous,
    }
    response = client.post("/v1/replans", json=body)
    assert response.status_code == 200
    result = response.json()
    assert any(task["task_id"] == "added-task-1" for task in result["schedule"]["tasks"])
    assert any(change["task_id"] == "added-task-1" and change["change_type"] == "ADDED" for change in result["changes"])


def test_replan_rejects_duplicate_event_payload_without_partial_response():
    request, previous = current_schedule()
    body = {
        "event": event("event-duplicate-task", previous["schedule_id"], "DISH_ADDED", {"tasks": [
            dict(request["tasks"][0], task_id="same-task", dish_id="d"),
            dict(request["tasks"][0], task_id="same-task", dish_id="d"),
        ]}),
        "schedule_request": request,
        "current_schedule": previous,
    }
    response = client.post("/v1/replans", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "DUPLICATE_TASK_ID"


def test_replan_preserves_completed_task_assignment_and_times():
    request, previous = current_schedule()
    completed = previous["tasks"][0]
    completed["status"] = "COMPLETED"
    completed["locked"] = True
    previous["tasks"][1]["status"] = "RUNNING"
    snapshot = {key: completed.get(key) for key in ("start_offset_sec", "end_offset_sec", "assigned_resources")}
    body = {
        "event": event("event-complete-preserve", previous["schedule_id"], "TASK_DELAYED", {
            "task_id": previous["tasks"][1]["task_id"], "delay_sec": 30,
        }),
        "schedule_request": request,
        "current_schedule": previous,
    }
    response = client.post("/v1/replans", json=body)
    assert response.status_code == 200
    updated = next(task for task in response.json()["schedule"]["tasks"] if task["task_id"] == completed["task_id"])
    assert {key: updated.get(key) for key in snapshot} == snapshot


def test_replan_rejects_ui_only_resources_field_in_current_schedule():
    """The V1 contract rejects UI-only fields if they leak into the replan request.

    The dashboard adds a top-level `resources` field that `schedule-response.schema.json`
    does not allow (`additionalProperties: false`). The frontend strips it before
    posting; this test pins the contract boundary so such a field can never silently
    enter a replan request again.
    """
    request, previous = current_schedule()
    previous["resources"] = [{"id": "stove_1", "label": "灶具", "tone": "gold"}]
    body = {
        "event": event("event-resources-1", previous["schedule_id"], "TASK_COMPLETED", {"task_id": previous["tasks"][0]["task_id"]}),
        "schedule_request": request,
        "current_schedule": previous,
    }
    response = client.post("/v1/replans", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_INPUT"
    messages = " ".join(detail["message"] for detail in response.json()["error"]["details"])
    assert "resources" in messages
