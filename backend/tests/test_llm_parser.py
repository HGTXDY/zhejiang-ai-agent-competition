import json

import pytest

from app.parser import LLMParserAdapter, RecipeParser
from app.parser.adapter import ParsedTaskError
from app.parser.llm import extract_json_array


def _recipe(steps: list[str]) -> dict:
    return {
        "schema_version": "1.0",
        "recipe_id": "steamed_fish",
        "name": "清蒸鲈鱼",
        "ingredients": ["鲈鱼", "葱", "姜"],
        "steps_text": steps,
        "source": "test",
    }


class FakeClient:
    def __init__(self, reply: str) -> None:
        self.reply = reply

    def complete(self, system: str, user: str) -> str:
        assert "device_type" in system or "设备" in system
        return self.reply


def _parse(reply: str, *, steps: list[str] | None = None):
    steps = steps or ["鲈鱼处理干净后加入葱姜。", "放入蒸箱，普通蒸100度8分钟后取出装盘。"]
    return RecipeParser(LLMParserAdapter(FakeClient(reply)), provider="llm").parse(_recipe(steps))


def test_llm_fields_are_overlaid_onto_a_valid_task():
    reply = json.dumps(
        [
            {
                "source_step_index": 0,
                "device_type": None,
                "duration_sec": 300,
                "manual_required": True,
                "manual_duration_sec": 180,
                "manual_segments": [{"offset_sec": 0, "duration_sec": 180, "action": "处理腌制"}],
                "predecessors": [],
                "interruptible": False,
                "confidence": 0.9,
            },
            {
                "source_step_index": 1,
                "device_type": "steamer",
                "mode": "normal_steam",
                "temperature_c": 100,
                "duration_sec": 480,
                "manual_required": True,
                "manual_duration_sec": 60,
                "predecessors": [0],
                "interruptible": False,
                "confidence": 0.95,
            },
        ]
    )
    tasks = _parse(reply).tasks

    steam = tasks[1]
    assert steam["resource_type"] == "hybrid"
    assert steam["device_requirement"]["device_type"] == "steamer"
    assert steam["device_requirement"]["mode"] == "normal_steam"
    assert steam["device_requirement"]["temperature_c"] == 100
    assert steam["duration_sec"] == 480
    assert steam["manual_required"] is True
    assert steam["field_status"]["temperature_c"] == "provided"
    assert steam["confidence"] == 0.95


def test_unconfigured_adapter_raises():
    adapter = LLMParserAdapter(client=None)
    with pytest.raises(ParsedTaskError, match="not configured"):
        adapter.parse(_recipe(["步骤"]))


def test_invalid_predecessors_are_ignored_not_propagated():
    # Step 1 references a non-existent step 9; the reference must be dropped so
    # the task set remains schedulable rather than failing downstream.
    reply = json.dumps(
        [
            {"source_step_index": 0, "predecessors": []},
            {"source_step_index": 1, "predecessors": [9]},
        ]
    )
    tasks = _parse(reply).tasks
    assert tasks[1]["predecessors"] == []


def test_llm_nonlinear_dependency_is_respected():
    steps = [
        "鸡翅洗净划刀。",
        "烤箱预热180度。",
        "鸡翅放入烤箱180度烤15分钟。",
    ]
    reply = json.dumps(
        [
            {"source_step_index": 0, "predecessors": []},
            {"source_step_index": 1, "predecessors": []},
            # Step 2 depends on step 0 and step 1, not just the previous step.
            {"source_step_index": 2, "predecessors": [0, 1]},
        ]
    )
    tasks = _parse(reply, steps=steps).tasks
    assert tasks[2]["predecessors"] == [tasks[0]["task_id"], tasks[1]["task_id"]]


def test_malformed_llm_output_falls_back_to_deterministic_baseline():
    # The model answers with prose and no array: parsing raises rather than
    # inventing tasks, so the caller can retry with the deterministic path.
    with pytest.raises(ParsedTaskError, match="no JSON array"):
        _parse("抱歉，我无法解析。")


def test_extract_json_array_handles_fenced_and_wrapped_output():
    assert extract_json_array("```json\n[1, 2]\n```") == [1, 2]
    assert extract_json_array('{"tasks": [{"a": 1}]}') == [{"a": 1}]
    with pytest.raises(ParsedTaskError):
        extract_json_array("no json here")


def test_llm_adapter_output_passes_full_v1_validation():
    reply = json.dumps(
        [
            {"source_step_index": 0, "device_type": None, "manual_required": True},
            {
                "source_step_index": 1,
                "device_type": "steamer",
                "mode": "normal_steam",
                "temperature_c": 100,
                "duration_sec": 480,
            },
        ]
    )
    result = _parse(reply)
    assert result.provider == "llm"
    assert all(task["schema_version"] == "1.0" for task in result.tasks)
