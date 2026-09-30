import pytest

from app.parser import FakeParserAdapter, RecipeParser
from app.parser.adapter import InputRecipeError, ParsedTaskError


RECIPE = {
    "schema_version": "1.0",
    "recipe_id": "steamed_fish",
    "name": "清蒸鲈鱼",
    "ingredients": ["鲈鱼", "葱", "姜"],
    "steps_text": ["处理并腌制5分钟。", "放入蒸箱100度蒸8分钟。"],
    "source": "test",
}


def task(*, field_status=None):
    return {
        "schema_version": "1.0",
        "task_id": "steamed_fish_steam",
        "dish_id": "steamed_fish",
        "action": "蒸鱼",
        "resource_type": "device",
        "device_requirement": {
            "device_type": "steamer",
            "mode": "steam",
            "temperature_c": 100,
            "capacity_units": 1,
        },
        "duration_sec": 480,
        "predecessors": [],
        "interruptible": False,
        "manual_required": False,
        "manual_duration_sec": 0,
        "field_status": field_status or {
            "duration_sec": "provided",
            "device_type": "provided",
            "device_mode": "provided",
            "temperature_c": "provided",
            "manual_duration_sec": "not_applicable",
        },
    }


def test_fake_adapter_returns_valid_v1_tasks_without_device_instance_assignment():
    result = RecipeParser(FakeParserAdapter({"steamed_fish": [task()]})).parse(RECIPE)

    assert result.provider == "fake"
    assert result.recipe_id == "steamed_fish"
    assert result.tasks[0]["device_requirement"]["device_type"] == "steamer"
    assert "device_id" not in result.tasks[0]


def test_invalid_recipe_is_rejected_before_adapter_is_called():
    invalid = {**RECIPE, "recipe_id": "INVALID ID"}

    with pytest.raises(InputRecipeError):
        RecipeParser(FakeParserAdapter({})).parse(invalid)


def test_unresolved_required_field_is_rejected():
    unresolved = task(field_status={"duration_sec": "missing", "device_type": "provided"})

    with pytest.raises(ParsedTaskError, match="duration_sec"):
        RecipeParser(FakeParserAdapter({"steamed_fish": [unresolved]})).parse(RECIPE)


def test_missing_fixture_does_not_fall_back_to_invented_tasks():
    with pytest.raises(ParsedTaskError, match="No fake parser fixture"):
        RecipeParser(FakeParserAdapter({})).parse(RECIPE)
