"""Tests for the PRD Table 19 REST endpoints (issue #49).

The stateful endpoints share the module-level in-memory store; the autouse
fixture clears it before and after each test so schedules never leak between
cases.
"""
import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import app
from app.store import store

ROOT = Path(__file__).resolve().parents[2]
client = TestClient(app)


@pytest.fixture(autouse=True)
def clear_store():
    store.clear()
    yield
    store.clear()


def load_fixture(name: str) -> dict:
    return json.loads((ROOT / "fixtures" / "v1" / name).read_text(encoding="utf-8"))


def test_list_recipes_returns_summaries():
    response = client.get("/recipes")
    assert response.status_code == 200
    body = response.json()
    assert body["schema_version"] == "1.0"
    assert body["total"] == 100
    assert len(body["recipes"]) == 100
    summary = body["recipes"][0]
    assert {"recipe_id", "name", "ingredient_count", "step_count"} <= set(summary)
    assert summary["step_count"] >= 1


def test_list_recipes_supports_limit_and_name_filter():
    response = client.get("/recipes", params={"limit": 5})
    assert response.status_code == 200
    assert len(response.json()["recipes"]) == 5

    filtered = client.get("/recipes", params={"q": "鸡翅"})
    assert filtered.status_code == 200
    names = [item["name"] for item in filtered.json()["recipes"]]
    assert names and all("鸡翅" in name for name in names)


def test_get_recipe_returns_parseable_payload_and_parse_succeeds():
    listed = client.get("/recipes", params={"limit": 1}).json()
    recipe_id = listed["recipes"][0]["recipe_id"]
    response = client.get(f"/recipes/{recipe_id}")
    assert response.status_code == 200
    payload = response.json()
    assert payload["recipe_id"] == recipe_id
    assert payload["steps_text"]

    parsed = client.post("/recipes/parse", json=payload)
    assert parsed.status_code == 200
    assert parsed.json()["recipe_id"] == recipe_id
    assert parsed.json()["tasks"]


def test_get_unknown_recipe_returns_404():
    response = client.get("/recipes/does-not-exist")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "RECIPE_NOT_FOUND"


def test_devices_validate_accepts_valid_config():
    device_config = load_fixture("four-dish-normal.json")["device_config"]
    response = client.post("/devices/validate", json=device_config)
    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is True
    assert body["errors"] == []
    assert {device["device_id"] for device in body["devices"]} == {
        device["device_id"] for device in device_config["devices"]
    }


def test_devices_validate_reports_duplicate_ids():
    device_config = copy.deepcopy(load_fixture("four-dish-normal.json")["device_config"])
    device_config["devices"].append(copy.deepcopy(device_config["devices"][0]))
    response = client.post("/devices/validate", json=device_config)
    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is False
    assert any(error["code"] == "DUPLICATE_DEVICE_ID" for error in body["errors"])


def test_devices_validate_reports_invalid_temperature_range():
    device_config = copy.deepcopy(load_fixture("four-dish-normal.json")["device_config"])
    device = next(d for d in device_config["devices"] if "temperature_min_c" in d.get("capabilities", {}))
    device["capabilities"]["temperature_min_c"] = 300
    device["capabilities"]["temperature_max_c"] = 100
    response = client.post("/devices/validate", json=device_config)
    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is False
    assert any(error["code"] == "INVALID_TEMPERATURE_RANGE" for error in body["errors"])


def test_schedules_endpoint_returns_same_shape_as_v1():
    request = load_fixture("four-dish-normal.json")
    v1 = client.post("/v1/schedules", json=request).json()
    canonical = client.post("/schedules", json=request).json()
    assert canonical["schedule_id"] == v1["schedule_id"]
    assert canonical["tasks"] == v1["tasks"]


def test_stateful_schedule_lifecycle_with_dish_added_event():
    request = load_fixture("four-dish-normal.json")
    created = client.post("/schedules", json=request)
    assert created.status_code == 200
    schedule = created.json()
    schedule_id = schedule["schedule_id"]

    fetched = client.get(f"/schedules/{schedule_id}")
    assert fetched.status_code == 200
    assert fetched.json()["schedule_id"] == schedule_id

    notifications = client.get(f"/schedules/{schedule_id}/notifications")
    assert notifications.status_code == 200
    body = notifications.json()
    assert body["schedule_id"] == schedule_id
    # Notification content is produced by #47 (key-node plan); on this branch the
    # endpoint only plumbes through whatever the schedule carries, so we assert
    # the field shape rather than non-emptiness.
    assert isinstance(body["notifications"], list)

    new_task = copy.deepcopy(request["tasks"][0])
    new_task["task_id"] = "added-dish-task"
    new_task["dish_id"] = "dish-added"
    new_task["action"] = "临时加菜"
    event = {
        "schema_version": "1.0",
        "event_id": "event-add-1",
        "event_type": "DISH_ADDED",
        "occurred_at": "2026-09-27T12:00:00Z",
        "payload": {"tasks": [new_task]},
    }
    reported = client.post(f"/schedules/{schedule_id}/events", json=event)
    assert reported.status_code == 200
    confirmation = reported.json()
    assert confirmation["accepted"] is True
    assert "added-dish-task" in confirmation["affected_task_ids"]

    new_id = confirmation["schedule_id"]
    assert new_id != schedule_id
    updated = client.get(f"/schedules/{new_id}").json()
    assert any(task["task_id"] == "added-dish-task" for task in updated["tasks"])
    # The old id still resolves to the latest schedule after a replan.
    assert any(task["task_id"] == "added-dish-task" for task in client.get(f"/schedules/{schedule_id}").json()["tasks"])


def test_unknown_schedule_returns_404():
    for path in ("/schedules/nope", "/schedules/nope/notifications"):
        response = client.get(path)
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "SCHEDULE_NOT_FOUND"
    response = client.post("/schedules/nope/events", json={"event_id": "e"})
    assert response.status_code == 404


def test_schedules_replan_endpoint_returns_full_replan_response():
    request = load_fixture("four-dish-normal.json")
    schedule = client.post("/schedules", json=request).json()
    schedule_id = schedule["schedule_id"]

    new_task = copy.deepcopy(request["tasks"][0])
    new_task["task_id"] = "replan-added-task"
    new_task["dish_id"] = "dish-replan"
    new_task["action"] = "再加一道"
    envelope = {
        "event": {
            "schema_version": "1.0",
            "event_id": "event-replan-1",
            "event_type": "DISH_ADDED",
            "occurred_at": "2026-09-27T12:00:00Z",
            "payload": {"tasks": [new_task]},
        },
    }
    response = client.post(f"/schedules/{schedule_id}/replan", json=envelope)
    assert response.status_code == 200
    body = response.json()
    assert body["previous_schedule_id"] == schedule_id
    assert any(task["task_id"] == "replan-added-task" for task in body["schedule"]["tasks"])
    assert any(change["task_id"] == "replan-added-task" and change["change_type"] == "ADDED" for change in body["changes"])
