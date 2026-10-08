"""Regression checks for mixed preparation + explicitly timed hold steps."""
from __future__ import annotations

import json

from app.catalog import get_recipe_payload, _load_recipes
from app.parser import DeterministicParserAdapter, LLMParserAdapter, RecipeParser
from app.parser.deterministic import extract_duration_sec


def _recipe(steps: list[str], recipe_id: str = "sample") -> dict:
    return {
        "schema_version": "1.0",
        "recipe_id": recipe_id,
        "name": "测试菜",
        "ingredients": ["原料"],
        "steps_text": steps,
        "source": "test",
    }


def _parse(steps: list[str]) -> list[dict]:
    return list(RecipeParser(DeterministicParserAdapter()).parse(_recipe(steps)).tasks)


def test_ice_meat_24_hours_keeps_refrigeration_separate_from_hands_on_preparation():
    recipe = get_recipe_payload("5c8646fe98d5bc7e184a90bc")  # 鸡仔饼
    assert recipe is not None
    source_steps = list(recipe["steps_text"])
    tasks = RecipeParser(DeterministicParserAdapter()).parse(recipe).tasks
    assert recipe["steps_text"] == source_steps  # immutable official material

    preparation, freezer, next_step = tasks[:3]
    assert preparation["resource_type"] == "manual"
    assert preparation["manual_required"] is True
    assert preparation["field_status"]["duration_sec"] == "defaulted"
    assert "洗净" in preparation["action"]
    assert freezer["resource_type"] == "device"
    assert freezer["device_requirement"]["device_type"] == "refrigerator"
    assert freezer["device_requirement"]["mode"] == "freeze"
    assert freezer["duration_sec"] == 86400
    assert freezer["manual_duration_sec"] == 0
    assert freezer["field_status"]["duration_sec"] == "provided"
    assert freezer["predecessors"] == [preparation["task_id"]]
    assert next_step["predecessors"] == [freezer["task_id"]]
    assert freezer["task_id"] == recipe["recipe_id"] + "_00"


def test_refrigerated_meat_marinade_with_english_hour_and_compound_chinese_hour():
    for recipe_id, hours in [
        ("661369554b3d03197733ac5a", 2),  # 香烤排骨: 2h
        ("5fe1972d5f8f38795ea6fe7b", 15),  # 秘制叉烧: 15 个小时
    ]:
        recipe = get_recipe_payload(recipe_id)
        tasks = RecipeParser(DeterministicParserAdapter()).parse(recipe).tasks
        prep = next(task for task in tasks if task["task_id"].endswith("_prep"))
        hold = next(task for task in tasks if task["predecessors"] == [prep["task_id"]])
        assert prep["resource_type"] == "manual"
        assert hold["device_requirement"]["device_type"] == "refrigerator"
        assert hold["duration_sec"] == hours * 3600
        assert hold["manual_duration_sec"] < hold["duration_sec"]


def test_soak_with_after_action_is_three_real_tasks_and_no_concurrent_human_use():
    recipe = get_recipe_payload("5c8200d96dc6e123a037a202")  # 豆豉蒸腐竹
    tasks = RecipeParser(DeterministicParserAdapter()).parse(recipe).tasks
    preparation, soak, finish = tasks[:3]
    assert [t["resource_type"] for t in tasks[:3]] == ["manual", "wait", "manual"]
    assert soak["duration_sec"] == 7200
    assert soak["manual_duration_sec"] == 0
    assert soak["predecessors"] == [preparation["task_id"]]
    assert finish["predecessors"] == [soak["task_id"]]
    assert "挤干水分" in finish["action"]


def test_two_hour_braise_and_uncertain_timed_phrasing_remain_unsplit():
    # Do not infer that a long stove occupation is a make-ahead stage.
    tasks = _parse(["将排骨放入锅中炖煮2小时，煮好后盛出。"])
    assert len(tasks) == 1
    assert tasks[0]["duration_sec"] == 7200
    assert tasks[0]["device_requirement"]["device_type"] == "stove"

    # '腌制好的' is a past participle; the 20 min belongs to baking, not marinating.
    tasks = _parse(["把腌制好的肉放入烤箱烤20分钟。"])
    assert len(tasks) == 1
    assert tasks[0]["device_requirement"]["device_type"] == "oven"

    # Unspecified fridge time is not split into a fabricated exact hold.
    tasks = _parse(["将面团揉匀，放入冰箱冷藏至定型。"])
    assert len(tasks) == 1


def test_duration_variants_and_incidental_device_mentions():
    assert extract_duration_sec("放冰箱腌制2h") == 7200
    assert extract_duration_sec("放冰箱腌制15 个小时") == 54000
    assert extract_duration_sec("静置半个小时") == 1800
    assert extract_duration_sec("浸泡30min") == 1800
    tasks = _parse(["将面团放在烘焙纸上，擀平，放入冰箱冷藏半小时。"])
    assert tasks[0]["resource_type"] == "manual"  # 烘焙纸 is not an oven
    assert tasks[1]["device_requirement"]["device_type"] == "refrigerator"


def test_all_official_recipes_remain_schema_valid_with_unique_ids_and_existing_order():
    parser = RecipeParser(DeterministicParserAdapter())
    split_count = 0
    for recipe in _load_recipes():
        tasks = parser.parse({**recipe, "schema_version": "1.0", "source": "official"}).tasks
        ids = [t["task_id"] for t in tasks]
        assert len(ids) == len(set(ids)), recipe["name"]
        for index, task in enumerate(tasks):
            assert task["predecessors"] == ([ids[index - 1]] if index else []), recipe["name"]
            if task["resource_type"] == "wait":
                assert task["manual_duration_sec"] == 0
        split_count += len(tasks) - len(recipe["steps_text"])
    assert split_count >= 2  # actual official hold/prep mixed steps are covered


def test_llm_indexed_baseline_keeps_one_task_per_source_step():
    # The other team's LLM interface assumes source_step_index maps 1:1 to tasks.
    class Client:
        def complete(self, system: str, user: str) -> str:
            return json.dumps([{"source_step_index": 0}, {"source_step_index": 1}])

    recipe = _recipe([
        "将肥肉洗净切粒，拌匀后冷冻24小时以上。",
        "将冰肉揉合成面团。",
    ])
    tasks = RecipeParser(LLMParserAdapter(client=Client())).parse(recipe).tasks
    assert len(tasks) == 2
    assert [t["source_step_index"] for t in tasks] == [0, 1]
    assert tasks[1]["predecessors"] == [tasks[0]["task_id"]]
