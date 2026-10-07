import json

from fastapi.testclient import TestClient

from app.api import create_app
from app.parser.llm import OpenAICompatClient


def _configured_client(monkeypatch, replies: list[dict]):
    monkeypatch.setenv("MODEL_BASE_URL", "https://models.example.test/v1")
    monkeypatch.setenv("MODEL_API_KEY", "fake-agent-key")
    monkeypatch.setenv("MODEL_NAME", "agent-model")
    queue = [json.dumps(reply, ensure_ascii=False) for reply in replies]
    monkeypatch.setattr(OpenAICompatClient, "complete", lambda self, system, user: queue.pop(0))
    return TestClient(create_app())


def _reply(*, recipes, target_time=None, operator_count=None, devices=None, reply="好的"):
    return {
        "intent": "create_schedule",
        "reply": reply,
        "draft": {
            "recipes": recipes,
            "target_time": target_time,
            "operator_count": operator_count,
            "devices": devices or {},
        },
        "unmatched_recipe_names": [],
    }


def test_agent_plan_requires_configured_model(monkeypatch):
    for name in ("MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_NAME"):
        monkeypatch.delenv(name, raising=False)
    response = TestClient(create_app()).post("/agent/plan", json={"message": "帮我安排晚饭"})
    assert response.status_code == 422
    assert "模型尚未配置" in response.json()["detail"]


def test_agent_plan_uses_model_then_validates_catalog(monkeypatch):
    recipes = [
        {"recipe_id": "6510fb3545256c3ad7c25c9c", "name": "苹果芒果派"},
        {"recipe_id": "661369554b3d03197733ac5a", "name": "香烤排骨"},
        {"recipe_id": "58e70b129f6429675ec80601", "name": "麻辣对虾"},
        {"recipe_id": "invented", "name": "模型编的菜"},
    ]
    client = _configured_client(monkeypatch, [_reply(recipes=recipes, target_time="18:30", operator_count=1, devices={"stove_count": 1, "steamer_count": 1, "oven_count": 1})])
    response = client.post("/agent/plan", json={"message": "今晚安排三道菜"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ready_to_confirm"] is True
    assert body["draft"]["target_time"] == "18:30"
    assert body["draft"]["operator_count"] == 1
    assert [item["name"] for item in body["draft"]["recipes"]] == ["苹果芒果派", "香烤排骨", "麻辣对虾"]
    assert body["tool_trace"][0]["label"] == "大模型已理解本轮需求"


def test_agent_plan_keeps_context_for_fields_omitted_by_model(monkeypatch):
    selected = [
        {"recipe_id": "6510fb3545256c3ad7c25c9c", "name": "苹果芒果派"},
        {"recipe_id": "661369554b3d03197733ac5a", "name": "香烤排骨"},
        {"recipe_id": "58e70b129f6429675ec80601", "name": "麻辣对虾"},
    ]
    client = _configured_client(monkeypatch, [
        _reply(recipes=selected, reply="还需要时间和厨房条件"),
        _reply(recipes=[], target_time="19:00", operator_count=2, devices={"stove_count": 1, "steamer_count": 0, "oven_count": 1}),
    ])
    first = client.post("/agent/plan", json={"message": "想做三道菜"}).json()
    second = client.post("/agent/plan", json={"message": "晚上七点，两个人，一个灶、没有蒸箱、一个烤箱", "context": first["draft"]}).json()
    assert second["ready_to_confirm"] is True
    assert len(second["draft"]["recipes"]) == 3
    assert second["draft"]["devices"]["steamer_count"] == 0


def test_agent_plan_rejects_non_json_model_output(monkeypatch):
    monkeypatch.setenv("MODEL_BASE_URL", "https://models.example.test/v1")
    monkeypatch.setenv("MODEL_API_KEY", "fake-agent-key")
    monkeypatch.setattr(OpenAICompatClient, "complete", lambda self, system, user: "无法处理")
    response = TestClient(create_app()).post("/agent/plan", json={"message": "帮我安排"})
    assert response.status_code == 502


def test_agent_command_understands_delay_and_device_failure():
    client = TestClient(create_app())
    tasks = [{"task_id": "t1", "action": "蒸鲈鱼", "dish_name": "家常鲈鱼"}]
    delayed = client.post("/agent/command", json={"message": "鲈鱼慢了十分钟", "tasks": tasks}).json()
    assert delayed["intent"] == "task_delayed"
    assert delayed["task_id"] == "t1"
    broken = client.post("/agent/command", json={"message": "蒸箱坏了", "tasks": tasks}).json()
    assert broken == {"intent": "device_unavailable", "reply": "已识别设备异常，将重新安排。", "device_id": "steamer_1", "ready": True}
