import json

from fastapi.testclient import TestClient

from app.api import create_app
from app.parser.llm import OpenAICompatClient

FULL_DEVICES = {
    "stove_count": 1,
    "steamer_count": 1,
    "oven_count": 1,
    "refrigerator_count": 1,
    "dishwasher_count": 1,
    "range_hood_count": 1,
    "water_purifier_count": 1,
}


def _configured_client(monkeypatch, replies: list[dict]):
    monkeypatch.setenv("MODEL_BASE_URL", "https://models.example.test/v1")
    monkeypatch.setenv("MODEL_API_KEY", "fake-agent-key")
    monkeypatch.setenv("MODEL_NAME", "agent-model")
    queue = [json.dumps(reply, ensure_ascii=False) for reply in replies]
    monkeypatch.setattr(OpenAICompatClient, "complete", lambda self, system, user: queue.pop(0))
    return TestClient(create_app())


def _reply(*, recipes, target_time=None, operator_count=None, devices=None, reply="好的", unmatched_recipe_names=None, intent="create_schedule"):
    return {
        "intent": intent,
        "reply": reply,
        "draft": {
            "recipes": recipes,
            "target_time": target_time,
            "operator_count": operator_count,
            "devices": devices or {},
        },
        "unmatched_recipe_names": unmatched_recipe_names or [],
    }


def test_agent_plan_requires_configured_model(monkeypatch):
    for name in ("MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_NAME"):
        monkeypatch.delenv(name, raising=False)
    response = TestClient(create_app()).post("/agent/plan", json={"message": "帮我安排晚饭"})
    assert response.status_code == 422
    assert "模型尚未配置" in response.json()["detail"]


def test_agent_plan_answers_catalog_question_without_forcing_planning_fields(monkeypatch):
    natural_reply = "菜谱库里有鸡翅包饭、苹果芒果派、低温牛排等 100 道菜。你偏爱肉菜、海鲜还是甜点？我可以再帮你缩小范围。"
    client = _configured_client(monkeypatch, [
        _reply(
            intent="answer_question",
            recipes=[],
            reply=natural_reply,
            unmatched_recipe_names=["用户只是询问的菜名"],
        )
    ])
    body = client.post("/agent/plan", json={"message": "你们菜谱里有什么菜？"}).json()
    assert body["intent"] == "answer_question"
    assert body["reply"] == natural_reply
    assert body["draft"]["recipes"] == []
    assert body["unmatched_recipe_names"] == []
    assert body["ready_to_confirm"] is False
    assert body["tool_trace"][1]["label"] == "已参考官方菜谱库回答"


def test_agent_catalog_question_keeps_a_complete_existing_plan_confirmable(monkeypatch):
    selected = [
        {"recipe_id": "6510fb3545256c3ad7c25c9c", "name": "苹果芒果派"},
        {"recipe_id": "661369554b3d03197733ac5a", "name": "香烤排骨"},
        {"recipe_id": "58e70b129f6429675ec80601", "name": "麻辣对虾"},
    ]
    client = _configured_client(monkeypatch, [
        _reply(intent="answer_question", recipes=[], reply="还有鸡翅包饭和低温牛排。")
    ])
    context = {
        "recipes": selected,
        "target_time": "18:30",
        "operator_count": 1,
        "devices": FULL_DEVICES,
    }
    body = client.post("/agent/plan", json={"message": "还有什么菜？", "context": context}).json()
    assert body["intent"] == "answer_question"
    assert body["draft"] == context
    assert body["ready_to_confirm"] is True


def test_agent_plan_keeps_natural_model_followup_when_plan_is_incomplete(monkeypatch):
    natural_reply = "这三道菜我找到了。你想几点开饭，今天有几个人一起做？"
    client = _configured_client(monkeypatch, [
        _reply(
            recipes=[
                {"recipe_id": "6510fb3545256c3ad7c25c9c", "name": "苹果芒果派"},
                {"recipe_id": "661369554b3d03197733ac5a", "name": "香烤排骨"},
                {"recipe_id": "58e70b129f6429675ec80601", "name": "麻辣对虾"},
            ],
            reply=natural_reply,
        )
    ])
    body = client.post("/agent/plan", json={"message": "我想做苹果芒果派、香烤排骨和麻辣对虾"}).json()
    assert body["intent"] == "create_schedule"
    assert body["reply"] == natural_reply
    assert body["ready_to_confirm"] is False


def test_agent_plan_rejects_invented_recipe_id_even_with_three_valid_recipes(monkeypatch):
    recipes = [
        {"recipe_id": "6510fb3545256c3ad7c25c9c", "name": "苹果芒果派"},
        {"recipe_id": "661369554b3d03197733ac5a", "name": "香烤排骨"},
        {"recipe_id": "58e70b129f6429675ec80601", "name": "麻辣对虾"},
        {"recipe_id": "invented", "name": "鸡翅包饭"},
    ]
    client = _configured_client(monkeypatch, [_reply(recipes=recipes, target_time="18:30", operator_count=1, devices=FULL_DEVICES)])
    response = client.post("/agent/plan", json={"message": "今晚安排四道菜"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ready_to_confirm"] is False
    assert body["draft"]["target_time"] == "18:30"
    assert body["draft"]["operator_count"] == 1
    assert [item["name"] for item in body["draft"]["recipes"]] == ["苹果芒果派", "香烤排骨", "麻辣对虾"]
    assert body["draft"]["devices"] == FULL_DEVICES
    assert body["unmatched_recipe_names"] == ["鸡翅包饭"]
    assert "鸡翅包饭" in body["reply"]
    assert body["tool_trace"][0]["label"] == "大模型已理解本轮需求"


def test_agent_plan_keeps_context_for_fields_omitted_by_model(monkeypatch):
    selected = [
        {"recipe_id": "6510fb3545256c3ad7c25c9c", "name": "苹果芒果派"},
        {"recipe_id": "661369554b3d03197733ac5a", "name": "香烤排骨"},
        {"recipe_id": "58e70b129f6429675ec80601", "name": "麻辣对虾"},
    ]
    client = _configured_client(monkeypatch, [
        _reply(recipes=selected, target_time="19:00", operator_count=2, devices={"stove_count": 1, "steamer_count": 0}, reply="还需要其余厨房条件"),
        _reply(recipes=[], devices={"oven_count": 1, "refrigerator_count": 1, "dishwasher_count": 0, "range_hood_count": 1, "water_purifier_count": 1}),
    ])
    first = client.post("/agent/plan", json={"message": "晚上七点，两个人，想做三道菜，一个灶、没有蒸箱"}).json()
    assert first["ready_to_confirm"] is False
    second = client.post("/agent/plan", json={"message": "再补充：一个烤箱、一个冰箱、没有洗碗机、一个烟机、一个净水机", "context": first["draft"]}).json()
    assert second["ready_to_confirm"] is True
    assert second["draft"]["recipes"] == selected
    assert second["draft"]["target_time"] == "19:00"
    assert second["draft"]["operator_count"] == 2
    assert second["draft"]["devices"] == {
        "stove_count": 1,
        "steamer_count": 0,
        "oven_count": 1,
        "refrigerator_count": 1,
        "dishwasher_count": 0,
        "range_hood_count": 1,
        "water_purifier_count": 1,
    }


def test_agent_plan_keeps_explicit_zero_device_counts(monkeypatch):
    selected = [
        {"recipe_id": "6510fb3545256c3ad7c25c9c", "name": "苹果芒果派"},
        {"recipe_id": "661369554b3d03197733ac5a", "name": "香烤排骨"},
        {"recipe_id": "58e70b129f6429675ec80601", "name": "麻辣对虾"},
    ]
    devices = {**FULL_DEVICES, "steamer_count": 0, "dishwasher_count": 0}
    client = _configured_client(monkeypatch, [_reply(recipes=selected, target_time="18:30", operator_count=1, devices=devices)])
    body = client.post("/agent/plan", json={"message": "没有蒸箱，也没有洗碗机，其余设备各一台"}).json()
    assert body["ready_to_confirm"] is True
    assert body["draft"]["devices"]["steamer_count"] == 0
    assert body["draft"]["devices"]["dishwasher_count"] == 0


def test_agent_plan_missing_any_device_blocks_confirmation(monkeypatch):
    selected = [
        {"recipe_id": "6510fb3545256c3ad7c25c9c", "name": "苹果芒果派"},
        {"recipe_id": "661369554b3d03197733ac5a", "name": "香烤排骨"},
        {"recipe_id": "58e70b129f6429675ec80601", "name": "麻辣对虾"},
    ]
    devices = {key: value for key, value in FULL_DEVICES.items() if key != "water_purifier_count"}
    client = _configured_client(monkeypatch, [_reply(recipes=selected, target_time="18:30", operator_count=1, devices=devices, reply="可以确认")])
    body = client.post("/agent/plan", json={"message": "先按这些条件安排"}).json()
    assert body["ready_to_confirm"] is False
    assert "water_purifier_count" in body["missing_fields"]
    assert "净水机或净咖一体机" in body["reply"]


def test_agent_plan_preserves_duplicate_recipe_names_by_recipe_id(monkeypatch):
    recipes = [
        {"recipe_id": "58e70b129f6429675ec80601", "name": "麻辣对虾"},
        {"recipe_id": "5fe197255f8f38795ea6fe79", "name": "麻辣对虾"},
        {"recipe_id": "6510fb3545256c3ad7c25c9c", "name": "苹果芒果派"},
    ]
    client = _configured_client(monkeypatch, [_reply(recipes=recipes, target_time="18:30", operator_count=1, devices=FULL_DEVICES)])
    body = client.post("/agent/plan", json={"message": "安排两条麻辣对虾记录和苹果芒果派"}).json()
    assert body["ready_to_confirm"] is True
    assert body["unmatched_recipe_names"] == []
    assert [item["recipe_id"] for item in body["draft"]["recipes"]] == [
        "58e70b129f6429675ec80601",
        "5fe197255f8f38795ea6fe79",
        "6510fb3545256c3ad7c25c9c",
    ]


def test_agent_plan_does_not_guess_recipe_id_from_ambiguous_duplicate_name(monkeypatch):
    recipes = [
        {"recipe_id": "6510fb3545256c3ad7c25c9c", "name": "苹果芒果派"},
        {"recipe_id": "661369554b3d03197733ac5a", "name": "香烤排骨"},
        {"recipe_id": "5d54bae2a9114174727c8b20", "name": "鸡翅包饭"},
        {"name": "麻辣对虾"},
    ]
    client = _configured_client(monkeypatch, [_reply(recipes=recipes, target_time="18:30", operator_count=1, devices=FULL_DEVICES)])
    body = client.post("/agent/plan", json={"message": "还提到麻辣对虾，但没有可靠 recipe_id"}).json()
    assert body["ready_to_confirm"] is False
    assert body["unmatched_recipe_names"] == ["麻辣对虾"]
    assert "麻辣对虾" in body["reply"]
    assert [item["recipe_id"] for item in body["draft"]["recipes"]] == [
        "6510fb3545256c3ad7c25c9c",
        "661369554b3d03197733ac5a",
        "5d54bae2a9114174727c8b20",
    ]


def test_agent_plan_merges_backend_rejections_with_model_unmatched_names(monkeypatch):
    recipes = [
        {"recipe_id": "6510fb3545256c3ad7c25c9c", "name": "苹果芒果派"},
        {"recipe_id": "661369554b3d03197733ac5a", "name": "香烤排骨"},
        {"recipe_id": "5d54bae2a9114174727c8b20", "name": "鸡翅包饭"},
        {"name": "不存在的菜"},
    ]
    client = _configured_client(monkeypatch, [
        _reply(
            recipes=recipes,
            target_time="18:30",
            operator_count=1,
            devices=FULL_DEVICES,
            unmatched_recipe_names=["模型未匹配菜", "不存在的菜"],
        )
    ])
    body = client.post("/agent/plan", json={"message": "安排四道菜"}).json()
    assert body["ready_to_confirm"] is False
    assert body["unmatched_recipe_names"] == ["模型未匹配菜", "不存在的菜"]
    assert "不存在的菜" in body["reply"]


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
