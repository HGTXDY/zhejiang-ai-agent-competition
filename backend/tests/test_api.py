import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.api import app

ROOT = Path(__file__).resolve().parents[2]
client = TestClient(app)


def load_fixture(name: str) -> dict:
    return json.loads((ROOT / "fixtures" / "v1" / name).read_text(encoding="utf-8"))


def test_health_endpoint():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_schedule_endpoint_runs_validation_and_scheduler():
    response = client.post("/v1/schedules", json=load_fixture("four-dish-normal.json"))
    assert response.status_code == 200
    body = response.json()
    assert body["solver"]["status"] in {"OPTIMAL", "FEASIBLE"}
    assert body["validation"]["valid"] is True
    assert body["metrics"]["target_delay_sec"] == 0


def test_schedule_endpoint_returns_contract_error_for_invalid_request():
    payload = load_fixture("four-dish-normal.json")
    payload["tasks"][0]["duration_sec"] = 0
    response = client.post("/v1/schedules", json=payload)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_INPUT"


def test_health_endpoint_allows_local_frontend_origin():
    response = client.get("/health", headers={"Origin": "http://localhost:5173"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


RECIPE = {
    "schema_version": "1.0",
    "recipe_id": "steamed_fish",
    "name": "清蒸鲈鱼",
    "ingredients": ["鲈鱼", "葱", "姜"],
    "steps_text": ["鲈鱼处理后加葱姜。", "放入蒸箱，普通蒸100度8分钟后取出装盘。"],
    "source": "test",
}


def test_parse_recipe_endpoint_returns_deterministic_tasks():
    response = client.post("/recipes/parse", json=RECIPE)
    assert response.status_code == 200
    body = response.json()
    assert body["recipe_id"] == "steamed_fish"
    assert body["provider"] == "deterministic"
    steam = next(task for task in body["tasks"] if task["resource_type"] == "hybrid")
    assert steam["device_requirement"]["device_type"] == "steamer"
    assert steam["duration_sec"] == 480


def test_parse_recipe_endpoint_rejects_invalid_recipe():
    payload = {**RECIPE, "recipe_id": "INVALID ID"}
    response = client.post("/recipes/parse", json=payload)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_INPUT"


def test_parse_recipe_endpoint_strict_mode_blocks_unresolved_duration():
    payload = {**RECIPE, "steps_text": ["热锅后放入食材。", "翻炒至熟即可。"]}
    response = client.post("/recipes/parse", json=payload, params={"strict": True})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "PARSE_FAILED"
