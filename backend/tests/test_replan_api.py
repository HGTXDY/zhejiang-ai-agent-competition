import copy
import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.api import app
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
