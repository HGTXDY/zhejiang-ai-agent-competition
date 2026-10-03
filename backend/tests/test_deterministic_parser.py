import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from app.parser import DeterministicParserAdapter, RecipeParser, default_device_config
from app.parser.adapter import ParsedTaskError
from app.scheduler import schedule

ROOT = Path(__file__).resolve().parents[2]


def _recipe(recipe_id: str, steps: list[str]) -> dict:
    return {
        "schema_version": "1.0",
        "recipe_id": recipe_id,
        "name": "测试菜",
        "ingredients": ["食材"],
        "steps_text": steps,
        "source": "test",
    }


def test_parse_steamed_fish_step_maps_device_mode_temperature_and_duration():
    recipe = _recipe(
        "steamed_fish",
        ["鲈鱼处理干净后加入葱姜。", "放入蒸箱，普通蒸100度8分钟后取出装盘。"],
    )
    result = RecipeParser(DeterministicParserAdapter()).parse(recipe)

    steam = next(task for task in result.tasks if task["resource_type"] in {"device", "hybrid"})
    assert steam["device_requirement"]["device_type"] == "steamer"
    assert steam["device_requirement"]["mode"] == "normal_steam"
    assert steam["device_requirement"]["temperature_c"] == 100
    assert steam["duration_sec"] == 480
    assert steam["manual_required"] is True
    assert steam["manual_segments"]
    assert steam["field_status"]["duration_sec"] == "provided"


def test_parse_is_deterministic_across_runs():
    recipe = _recipe(
        "baked_wings",
        ["鸡翅洗净划刀。", "放入烤箱，常规烘焙180度烤15分钟。", "取出装盘。"],
    )
    first = RecipeParser(DeterministicParserAdapter()).parse(recipe).tasks
    second = RecipeParser(DeterministicParserAdapter()).parse(recipe).tasks
    assert first == second


def test_manual_step_without_duration_defaults_with_provenance():
    recipe = _recipe("salad", ["胡萝卜洗净切碎。", "加入盐拌匀。"])
    tasks = RecipeParser(DeterministicParserAdapter()).parse(recipe).tasks

    prep = tasks[0]
    assert prep["resource_type"] == "manual"
    assert prep["manual_required"] is True
    assert prep["duration_sec"] > 0
    assert prep["field_status"]["duration_sec"] == "defaulted"


def test_strict_mode_marks_unresolved_device_duration_missing_and_blocks():
    recipe = _recipe("stir_fry", ["热锅后放入食材。", "翻炒至熟即可。"])
    # The device step has no explicit duration: strict mode must reject it.
    with pytest.raises(ParsedTaskError, match="duration_sec"):
        RecipeParser(DeterministicParserAdapter(strict=True)).parse(recipe)

    # Non-strict mode defaults the duration so the recipe stays scheduleable.
    tasks = RecipeParser(DeterministicParserAdapter()).parse(recipe).tasks
    assert all(task["duration_sec"] > 0 for task in tasks)


def test_parsed_recipe_schedules_against_default_device_config():
    recipe = _recipe(
        "steamed_fish",
        ["鲈鱼处理干净后加入葱姜。", "放入蒸箱，普通蒸100度8分钟后取出装盘。"],
    )
    tasks = list(RecipeParser(DeterministicParserAdapter()).parse(recipe).tasks)
    request = {
        "schema_version": "1.0",
        "request_id": "parsed_steamed_fish",
        "tasks": tasks,
        "device_config": default_device_config(),
    }
    response = schedule(request)
    assert response["solver"]["status"] in {"OPTIMAL", "FEASIBLE"}
    assert response["validation"]["valid"] is True


def test_default_device_config_satisfies_v1_device_schema():
    schema = json.loads((ROOT / "contracts" / "v1" / "schemas" / "device.schema.json").read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)
    config = default_device_config()
    assert list(validator.iter_errors(config)) == []


def test_combo_oven_steamer_splits_by_explicit_mode():
    parser = RecipeParser(DeterministicParserAdapter())

    steamed = parser.parse(_recipe("combo_steam", ["放入蒸烤箱，普通蒸100度15分钟后取出。"])).tasks
    steam_task = next(task for task in steamed if task["resource_type"] in {"device", "hybrid"})
    assert steam_task["device_requirement"]["device_type"] == "steamer"
    assert steam_task["device_requirement"]["mode"] == "normal_steam"

    baked = parser.parse(_recipe("combo_bake", ["放入蒸烤箱，上下火180度烤20分钟。"])).tasks
    oven_task = next(task for task in baked if task["resource_type"] in {"device", "hybrid"})
    assert oven_task["device_requirement"]["device_type"] == "oven"
    assert oven_task["device_requirement"]["mode"] == "upper_lower_heat"


def test_combo_oven_steamer_infers_steam_from_water_tank():
    parser = RecipeParser(DeterministicParserAdapter())
    tasks = parser.parse(
        _recipe("combo_tank", ["放入方太智能烹饪设备第2层，开启电源，取出水箱加满水，选择开始烹饪按键，按屏幕提示操作。"])
    ).tasks
    device_tasks = [task for task in tasks if task["resource_type"] in {"device", "hybrid"}]
    assert device_tasks
    assert all(task["device_requirement"]["device_type"] == "steamer" for task in device_tasks)


def test_combo_oven_steamer_without_signal_is_not_guessed():
    parser = RecipeParser(DeterministicParserAdapter())
    tasks = parser.parse(
        _recipe("combo_none", ["打开方太智能烹饪设备，选择开始烹饪按键，按屏幕提示操作。"])
    ).tasks
    assert all(task["resource_type"] in {"manual", "wait"} for task in tasks)


def test_net_cafe_combo_maps_to_water_purifier_with_coffee_mode():
    parser = RecipeParser(DeterministicParserAdapter())
    tasks = parser.parse(_recipe("coffee", ["使用净咖一体机，选择美式模式，60度即热出水。"])).tasks
    device_task = next(task for task in tasks if task["resource_type"] in {"device", "hybrid"})
    assert device_task["device_requirement"]["device_type"] == "water_purifier"
    assert device_task["device_requirement"]["mode"] == "coffee"


def test_refrigerator_capability_covers_freezer_range():
    config = default_device_config()
    fridge = next(device for device in config["devices"] if device["device_type"] == "refrigerator")
    assert fridge["capabilities"]["temperature_min_c"] == -24
    assert fridge["capabilities"]["temperature_max_c"] == 10


def test_freeze_mode_defaults_to_freezer_temperature() -> None:
    parser = RecipeParser(DeterministicParserAdapter())
    tasks = parser.parse(_recipe("freeze_default", ["放入冰箱冷冻，定型后取出。"])).tasks
    task = next(task for task in tasks if task["resource_type"] in {"device", "hybrid"})
    requirement = task["device_requirement"]
    assert requirement["device_type"] == "refrigerator"
    assert requirement["mode"] == "freeze"
    assert requirement["temperature_c"] == -18
    assert task["field_status"]["temperature_c"] == "inferred"


def test_chill_mode_keeps_refrigerator_temperature() -> None:
    parser = RecipeParser(DeterministicParserAdapter())
    tasks = parser.parse(_recipe("chill_default", ["放入冰箱冷藏，静置后取出。"])).tasks
    task = next(task for task in tasks if task["resource_type"] in {"device", "hybrid"})
    assert task["device_requirement"]["mode"] == "chill"
    assert task["device_requirement"]["temperature_c"] == 4
