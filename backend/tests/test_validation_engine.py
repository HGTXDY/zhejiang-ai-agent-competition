import copy
import json
from pathlib import Path

from app.scheduler import schedule
from app.validation import build_device_candidates, validate_schedule_request, validate_schedule_result

ROOT = Path(__file__).resolve().parents[2]


def load_fixture(name: str) -> dict:
    return json.loads((ROOT / "fixtures" / "v1" / name).read_text(encoding="utf-8"))


def test_normal_request_and_result_pass_without_fastapi_or_ortools_coupling():
    request = load_fixture("four-dish-normal.json")
    assert validate_schedule_request(request).valid
    result = schedule(request)
    checked = validate_schedule_result(request, result)
    assert checked.valid, checked.as_dict()


def test_candidates_respect_mode_temperature_capacity_and_availability():
    request = load_fixture("four-dish-normal.json")
    candidates = build_device_candidates(request)
    assert candidates["ribs_blanch"] == ["stove_burner_1", "stove_burner_2"]
    assert candidates["fish_steam"] == ["steamer_1"]


def test_request_validation_rejects_dependency_and_resource_errors():
    request = load_fixture("four-dish-normal.json")
    request["tasks"][0]["predecessors"] = ["missing_task"]
    result = validate_schedule_request(request)
    assert not result.valid
    assert any(error.code == "DANGLING_PREDECESSOR" for error in result.errors)

    unavailable = load_fixture("four-dish-resource-insufficient.json")
    result = validate_schedule_request(unavailable)
    assert not result.valid
    assert any(error.code == "DEVICE_TYPE_UNAVAILABLE" for error in result.errors)


def test_result_validation_detects_duration_dependency_and_device_conflicts():
    request = load_fixture("four-dish-normal.json")
    result = schedule(request)
    result["tasks"][0]["end_offset_sec"] += 1
    checked = validate_schedule_result(request, result)
    assert not checked.valid
    assert any(error.code == "TASK_DURATION_MISMATCH" for error in checked.errors)


def test_result_validation_detects_overlapping_operator_work():
    request = load_fixture("four-dish-normal.json")
    request["device_config"]["operator_count"] = 1
    result = schedule(request)
    by_id = {task["task_id"]: task for task in result["tasks"]}
    by_id["fish_prepare"]["start_offset_sec"] = by_id["ribs_prepare"]["start_offset_sec"]
    by_id["fish_prepare"]["end_offset_sec"] = by_id["fish_prepare"]["start_offset_sec"] + request["tasks"][2]["duration_sec"]
    checked = validate_schedule_result(request, result)
    assert not checked.valid
    assert any(error.code == "OPERATOR_CAPACITY_CONFLICT" for error in checked.errors)


def test_result_validation_detects_three_way_device_capacity_conflict():
    request = load_fixture("four-dish-normal.json")
    request["device_config"]["devices"][2]["capacity_units"] = 2
    request["tasks"][0]["resource_type"] = "device"
    request["tasks"][0]["manual_required"] = False
    request["tasks"][0]["manual_duration_sec"] = 0
    request["tasks"][0]["device_requirement"] = {
        "device_type": "steamer",
        "mode": "normal_steam",
        "temperature_c": 100,
        "capacity_units": 1,
    }
    request["tasks"][1]["device_requirement"] = {
        "device_type": "steamer",
        "mode": "normal_steam",
        "temperature_c": 100,
        "capacity_units": 1,
    }
    request["tasks"][2]["device_requirement"] = {
        "device_type": "steamer",
        "mode": "normal_steam",
        "temperature_c": 100,
        "capacity_units": 1,
    }
    result = schedule(request)
    # Force three compatible tasks into one two-unit steamer interval.
    for item in result["tasks"][:3]:
        item["assigned_resources"] = ["steamer_1"]
        item["start_offset_sec"] = 0
        item["end_offset_sec"] = request["tasks"][[t["task_id"] for t in request["tasks"]].index(item["task_id"])]["duration_sec"]
    checked = validate_schedule_result(request, result)
    assert not checked.valid
    assert any(error.code == "DEVICE_CAPACITY_CONFLICT" for error in checked.errors)


def test_request_validation_returns_specific_capability_error_codes():
    request = load_fixture("four-dish-normal.json")
    request["tasks"][4]["device_requirement"]["mode"] = "high_pressure_steam"
    result = validate_schedule_request(request)
    assert any(error.code == "DEVICE_MODE_UNSUPPORTED" for error in result.errors)

    request = load_fixture("four-dish-normal.json")
    request["tasks"][4]["device_requirement"]["temperature_c"] = 300
    result = validate_schedule_request(request)
    assert any(error.code == "DEVICE_TEMPERATURE_UNSUPPORTED" for error in result.errors)

    request = load_fixture("four-dish-normal.json")
    request["tasks"][4]["device_requirement"]["capacity_units"] = 3
    result = validate_schedule_request(request)
    assert any(error.code == "DEVICE_CAPACITY_INSUFFICIENT" for error in result.errors)


def test_result_validation_rejects_incompatible_shared_steamer_settings():
    request = load_fixture("four-dish-normal.json")
    second = copy.deepcopy(request["tasks"][4])
    second["task_id"] = "fish_steam_second"
    second["device_requirement"]["mode"] = "different_steam"
    second["predecessors"] = []
    request["tasks"].append(second)
    # Keep the new mode valid at request level by adding it to the device capability.
    request["device_config"]["devices"][2]["capabilities"]["modes"].append("different_steam")
    result = schedule(request)
    first = next(item for item in result["tasks"] if item["task_id"] == "fish_steam")
    extra = {**first, "task_id": "fish_steam_second", "start_offset_sec": first["start_offset_sec"], "end_offset_sec": first["end_offset_sec"]}
    result["tasks"].append(extra)
    extra["assigned_resources"] = ["steamer_1"]
    checked = validate_schedule_result(request, result)
    assert not checked.valid
    assert any(error.code == "DEVICE_MODE_CONFLICT" for error in checked.errors)
