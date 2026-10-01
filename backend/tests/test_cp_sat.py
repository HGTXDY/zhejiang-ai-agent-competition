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
