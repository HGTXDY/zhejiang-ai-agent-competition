from app.metrics import (
    finish_spread_sec,
    hierarchical_objective,
    max_continuous_manual_sec,
    serial_baseline_makespan_sec,
)


def test_finish_spread_uses_last_task_of_each_dish():
    scheduled = [
        {"task_id": "a1", "dish_id": "a", "end_offset_sec": 100},
        {"task_id": "a2", "dish_id": "a", "end_offset_sec": 300},
        {"task_id": "b1", "dish_id": "b", "end_offset_sec": 240},
    ]
    assert finish_spread_sec(scheduled) == 60


def test_manual_segments_merge_when_gap_is_within_configured_threshold():
    scheduled = [
        {"task_id": "a", "dish_id": "d", "start_offset_sec": 0},
        {"task_id": "b", "dish_id": "d", "start_offset_sec": 120},
    ]
    definitions = [
        {"task_id": "a", "manual_required": True, "manual_duration_sec": 60, "manual_segments": []},
        {"task_id": "b", "manual_required": True, "manual_duration_sec": 60, "manual_segments": []},
    ]
    # a ends at 60, b starts at 120: gap is exactly 60 and therefore not merged at threshold 30.
    assert max_continuous_manual_sec(scheduled, definitions) == 60
    assert max_continuous_manual_sec(scheduled, definitions, merge_gap_sec=60) == 180


def test_serial_baseline_and_lexicographic_objective():
    tasks = [{"duration_sec": 10}, {"duration_sec": 20}]
    assert serial_baseline_makespan_sec(tasks) == 30
    assert hierarchical_objective(
        hard_constraint_violations=0,
        finish_spread=5,
        makespan=30,
        max_continuous_manual=12,
    ) == (0, 5, 30, 12)
