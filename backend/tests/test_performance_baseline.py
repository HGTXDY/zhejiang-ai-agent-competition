from pathlib import Path

from scripts.benchmark_performance import (
    INITIAL_BUDGET_MS,
    REPLAN_BUDGET_MS,
    measure_end_to_end,
    measure_initial,
    measure_replan,
    measure_replan_dish_added,
    percentile,
)

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "fixtures" / "v1" / "four-dish-normal.json"


def test_percentile_is_monotonic_and_bounded():
    samples = [1.0, 2.0, 3.0, 4.0, 5.0]
    assert percentile(samples, 0.0) == 1.0
    assert percentile(samples, 1.0) == 5.0
    assert percentile(samples, 0.5) == 3.0


def test_initial_schedule_benchmark_within_budget():
    result = measure_initial(FIXTURE, iterations=5, warmup=1)
    assert result["solver_statuses"] == ["OPTIMAL"]
    assert result["budget_ms"] == INITIAL_BUDGET_MS
    assert result["within_budget"] is True


def test_replan_benchmark_within_budget():
    result = measure_replan(FIXTURE, iterations=5, warmup=1)
    assert result["budget_ms"] == REPLAN_BUDGET_MS
    assert result["within_budget"] is True


def test_replan_dish_added_benchmark_within_budget():
    result = measure_replan_dish_added(FIXTURE, iterations=5, warmup=1)
    assert result["scenario"] == "DISH_ADDED"
    assert result["budget_ms"] == REPLAN_BUDGET_MS
    assert result["within_budget"] is True


def test_end_to_end_benchmark_single_recipe():
    payload = {
        "schema_version": "1.0",
        "recipe_id": "bench_one",
        "name": "单菜",
        "ingredients": ["食材"],
        "steps_text": ["放入蒸箱，普通蒸100度8分钟后取出。"],
        "source": "test",
    }
    result = measure_end_to_end([payload], iterations=2, warmup=1)
    assert result["recipes"] == 1
    assert result["solver_statuses"] == ["OPTIMAL"]
    assert result["pipeline"] == ["parse", "schema_and_business_validation", "solve", "notification"]
    assert result["validation_ms"]["max"] > 0
    assert result["solve_ms"]["max"] > 0
    assert result["notification_ms"]["max"] >= 0
    assert result["total_ms"]["max"] > 0
