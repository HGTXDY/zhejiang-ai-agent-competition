import pytest

from app.parser import DeterministicParserAdapter, RecipeParser, default_device_config
from app.parser.adapter import ParsedTaskError
from app.scheduler import schedule


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
