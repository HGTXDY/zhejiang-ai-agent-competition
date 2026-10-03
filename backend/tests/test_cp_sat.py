import copy
import json
from pathlib import Path

from app.metrics import finish_spread_sec, max_continuous_manual_sec
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


def test_solver_status_error_distinguishes_unknown_from_infeasible():
    from app.scheduler.cp_sat import _error_response

    request = load_fixture("four-dish-normal.json")
    unknown = _error_response(request, "SOLVER_TIMEOUT", "timed out", 10, status="UNKNOWN")
    infeasible = _error_response(request, "NO_FEASIBLE_SCHEDULE", "no solution", 10, status="INFEASIBLE")
    assert unknown["solver"]["status"] == "UNKNOWN"
    assert unknown["validation"]["errors"][0]["code"] == "SOLVER_TIMEOUT"
    assert infeasible["solver"]["status"] == "INFEASIBLE"


def test_multi_objective_metrics_are_computed_from_schedule() -> None:
    """The scheduler reports real objective metrics, not hardcoded zeros.

    `finish_spread_sec` and `max_continuous_manual_sec` must be derived from the
    scheduled tasks and agree with the shared `app.metrics` implementation, so the
    multi-objective solver integration and the metric layer stay in lock-step.
    """
    request = load_fixture("four-dish-normal.json")
    result = schedule(request)
    assert result["solver"]["status"] in {"OPTIMAL", "FEASIBLE"}
    scheduled_tasks = result["tasks"]

    assert result["metrics"]["finish_spread_sec"] == finish_spread_sec(scheduled_tasks)
    assert result["metrics"]["max_continuous_manual_sec"] == max_continuous_manual_sec(
        scheduled_tasks, request["tasks"]
    )
    # The four dishes share one operator, so the metrics are non-trivial.
    assert result["metrics"]["finish_spread_sec"] > 0
    assert result["metrics"]["max_continuous_manual_sec"] > 0


def _manual_task(task_id: str, dish_id: str, duration: int, predecessors: list[str]) -> dict:
    return {
        "schema_version": "1.0",
        "task_id": task_id,
        "dish_id": dish_id,
        "action": task_id,
        "predecessors": predecessors,
        "interruptible": False,
        "resource_type": "manual",
        "duration_sec": duration,
        "manual_required": True,
        "manual_duration_sec": duration,
        "manual_segments": [],
    }


def _wait_task(task_id: str, dish_id: str, duration: int, predecessors: list[str]) -> dict:
    return {
        "schema_version": "1.0",
        "task_id": task_id,
        "dish_id": dish_id,
        "action": task_id,
        "predecessors": predecessors,
        "interruptible": False,
        "resource_type": "wait",
        "duration_sec": duration,
        "manual_required": False,
        "manual_duration_sec": 0,
    }


def _device_task(task_id: str, dish_id: str, duration: int, predecessor: str) -> dict:
    return {
        "schema_version": "1.0",
        "task_id": task_id,
        "dish_id": dish_id,
        "action": task_id,
        "predecessors": [predecessor],
        "interruptible": False,
        "resource_type": "device",
        "duration_sec": duration,
        "manual_required": False,
        "manual_duration_sec": 0,
        "device_requirement": {"device_type": "stove", "mode": "stir_fry", "capacity_units": 1},
    }


def _single_stove_device_config() -> dict:
    return {
        "schema_version": "1.0",
        "operator_count": 1,
        "devices": [
            {
                "device_id": "stove_1",
                "device_type": "stove",
                "capacity_units": 1,
                "capabilities": {"modes": ["stir_fry"], "temperature_min_c": 60, "temperature_max_c": 250},
                "available": True,
            }
        ],
    }


def test_merge_gap_zero_is_not_treated_as_default() -> None:
    """A merge gap of 0 must merge only zero-gap segments, not fall back to 30.

    `m1` and `m2` are separated by a fixed 20s wait task, so the gap is always 20.
    With `manual_merge_gap_sec = 0` they stay two 60s blocks; with 30 they merge
    into one 140s block. This guards the `objective.get(...) or 30` regression
    where the schema-valid 0 was silently replaced by the default.
    """
    def request(gap: int) -> dict:
        return {
            "schema_version": "1.0",
            "request_id": "merge_gap_zero",
            "tasks": [
                _manual_task("m1", "A", 60, []),
                _wait_task("w", "A", 20, ["m1"]),
                _manual_task("m2", "B", 60, ["w"]),
            ],
            "device_config": {"schema_version": "1.0", "operator_count": 1, "devices": []},
            "objective": {"manual_merge_gap_sec": gap, "max_solve_time_sec": 10},
        }

    assert schedule(request(0))["metrics"]["max_continuous_manual_sec"] == 60
    assert schedule(request(30))["metrics"]["max_continuous_manual_sec"] == 140


def test_merge_gap_changes_third_objective_and_metric() -> None:
    """The third solve stage optimises continuous manual load, so the merge gap
    changes both the chosen schedule and the reported metric.

    `ma` and `mb` are two 60s manual tasks; a 300s device task lets `mb` slide
    freely between "right after `ma`" and "just before `db`". With a small merge
    gap the solver pulls them apart (gap > 30) for a 60s metric; with a large gap
    they stay merged for a 120s metric.
    """
    def request(gap: int) -> dict:
        return {
            "schema_version": "1.0",
            "request_id": "merge_gap_objective",
            "tasks": [
                _manual_task("ma", "A", 60, []),
                _device_task("da", "A", 300, "ma"),
                _manual_task("mb", "B", 60, []),
                _device_task("db", "B", 60, "mb"),
            ],
            "device_config": _single_stove_device_config(),
            "objective": {"manual_merge_gap_sec": gap, "max_solve_time_sec": 10},
        }

    narrow = schedule(request(30))
    wide = schedule(request(300))
    assert narrow["solver"]["status"] in {"OPTIMAL", "FEASIBLE"}
    assert wide["solver"]["status"] in {"OPTIMAL", "FEASIBLE"}
    assert narrow["metrics"]["max_continuous_manual_sec"] == 60
    assert wide["metrics"]["max_continuous_manual_sec"] == 120
