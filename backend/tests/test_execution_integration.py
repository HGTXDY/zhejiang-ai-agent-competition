"""Product-level acceptance checks for the execution/replan contract."""
from __future__ import annotations

import copy
import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.api import app
from app.scheduler import schedule

ROOT = Path(__file__).resolve().parents[2]
client = TestClient(app)


def request_fixture() -> dict:
    return json.loads((ROOT / "fixtures/v1/four-dish-normal.json").read_text(encoding="utf-8"))


def event(schedule_id: str, event_type: str, payload: dict, suffix: str) -> dict:
    return {
        "schema_version": "1.0",
        "event_id": f"integration-{suffix}",
        "schedule_id": schedule_id,
        "event_type": event_type,
        "occurred_at": "2026-09-30T12:00:00Z",
        "payload": payload,
    }


def replan_body(event_payload: dict, current: dict, request: dict) -> dict:
    return {"event": event_payload, "schedule_request": request, "current_schedule": current}


def test_execution_events_are_api_consumable_as_one_product_loop() -> None:
    request = request_fixture()
    current = schedule(request)
    current["tasks"][0]["status"] = "RUNNING"
    current["tasks"][0]["locked"] = True

    completed = client.post(
        "/v1/replans",
        json=replan_body(event(current["schedule_id"], "TASK_COMPLETED", {"task_id": current["tasks"][0]["task_id"]}, "complete"), current, request),
    )
    assert completed.status_code == 200
    completed_body = completed.json()
    assert completed_body["schedule"]["tasks"][0]["status"] == "COMPLETED"
    assert completed_body["schedule"]["tasks"][0]["locked"] is True

    delayed_current = copy.deepcopy(completed_body["schedule"])
    delayed_task = next(task for task in delayed_current["tasks"] if task["status"] not in {"COMPLETED", "LOCKED"})
    delayed = client.post(
        "/v1/replans",
        json=replan_body(event(delayed_current["schedule_id"], "TASK_DELAYED", {"task_id": delayed_task["task_id"], "delay_sec": 60}, "delay"), delayed_current, request),
    )
    assert delayed.status_code == 200
    delayed_body = delayed.json()
    assert delayed_body["changes"]
    assert "disruption_metrics" in delayed_body
    assert delayed_body["schedule"]["validation"]["valid"] is True
