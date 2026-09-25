import json
from pathlib import Path

from app.scheduler import schedule

ROOT = Path(__file__).resolve().parents[2]


def load_fixture(name: str) -> dict:
    return json.loads((ROOT / "fixtures" / "v1" / name).read_text())


def test_four_dish_fixture_is_feasible_and_dependency_safe() -> None:
    result = schedule(load_fixture("four-dish-normal.json"))
    assert result["solver"]["status"] in {"OPTIMAL", "FEASIBLE"}
    assert result["validation"]["valid"] is True
    assert result["metrics"]["device_conflicts"] == 0
    assert result["metrics"]["dependency_violations"] == 0
    by_id = {task["task_id"]: task for task in result["tasks"]}
    assert by_id["ribs_braise"]["start_offset_sec"] >= by_id["ribs_blanch"]["end_offset_sec"]
    assert by_id["fish_steam"]["start_offset_sec"] >= by_id["fish_prepare"]["end_offset_sec"]


def test_unavailable_device_returns_stable_error() -> None:
    result = schedule(load_fixture("four-dish-resource-insufficient.json"))
    assert result["solver"]["status"] == "INFEASIBLE"
    assert result["validation"]["errors"][0]["code"] == "NO_COMPATIBLE_DEVICE"
