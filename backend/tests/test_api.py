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
