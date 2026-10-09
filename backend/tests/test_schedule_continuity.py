"""Normal meal scheduling stays score-first; fresh prep is only a spare-time tie-break."""
from __future__ import annotations

from app.scheduler import schedule
from app.scheduler.continuity import fresh_prep_edges, unusually_idle_edges


def task(task_id: str, dish: str, action: str, duration: int, predecessors: list[str], *,
         resource_type: str = "manual", device_type: str | None = None) -> dict:
    entry = {
        "schema_version": "1.0", "task_id": task_id, "dish_id": dish,
        "action": action, "predecessors": predecessors, "interruptible": False,
        "resource_type": resource_type, "duration_sec": duration,
        "manual_required": resource_type in {"manual", "hybrid"},
        "manual_duration_sec": duration if resource_type == "manual" else 0,
        "manual_segments": [],
    }
    if device_type is not None:
        entry["device_requirement"] = {
            "device_type": device_type, "mode": "stir_fry" if device_type == "stove" else None,
            "capacity_units": 1,
        }
    return entry


def test_only_short_prep_followed_immediately_by_real_cooking_is_eligible():
    tasks = [
        task("veg", "A", "洗净切碎青菜", 60, []),
        task("fry", "A", "入锅翻炒青菜", 300, ["veg"], resource_type="device", device_type="stove"),
        task("meat", "B", "切肉丁", 90, []),
        task("freeze", "B", "冷冻24小时", 24 * 3600, ["meat"], resource_type="device", device_type="refrigerator"),
        task("roast", "B", "入烤箱烤制", 600, ["freeze"], resource_type="device", device_type="oven"),
        task("long_prep", "C", "将蔬菜清洗切碎", 1500, []),
        task("c_cook", "C", "下锅炒", 120, ["long_prep"], resource_type="device", device_type="stove"),
        task("mix", "D", "把香蕉切片加入烤碗", 60, []),
        task("bowl", "D", "将食材放入烤碗拌匀", 60, ["mix"]),
        task("multi", "E", "洗净切碎洋葱", 60, []),
        task("first", "E", "入锅翻炒", 60, ["multi"], resource_type="device", device_type="stove"),
        task("second", "E", "放入蒸箱蒸制", 60, ["multi"], resource_type="device", device_type="steamer"),
        task("marinate", "F", "洗切后腌制2小时", 7200, []),
        task("f_cook", "F", "下锅炒", 300, ["marinate"], resource_type="device", device_type="stove"),
    ]
    before = [t.copy() for t in tasks]
    assert fresh_prep_edges(tasks) == [("veg", "fry")]
    assert tasks == before


def test_only_long_over_three_hours_of_idle_is_considered():
    class FakeSolver:
        def Value(self, var):
            return var

    edges = [("p1", "c1"), ("p2", "c2"), ("p3", "c3")]
    starts = {"c1": 7200, "c2": 3 * 3600, "c3": 3 * 3600 + 1}
    ends = {"p1": 0, "p2": 0, "p3": 0}
    assert unusually_idle_edges(edges, starts, ends, FakeSolver()) == [("p3", "c3")]


def test_typical_meal_does_not_invoke_extra_solve():
    request = {
        "schema_version": "1.0", "request_id": "normal_meal_no_extra_solve",
        "tasks": [
            task("wash", "A", "洗净切碎青菜", 60, []),
            task("fry", "A", "入锅翻炒青菜", 300, ["wash"], resource_type="device", device_type="stove"),
            task("roast", "B", "入烤箱烤制", 1200, [], resource_type="device", device_type="oven"),
        ],
        "device_config": {"schema_version": "1.0", "operator_count": 1, "devices": [
            {"device_id": "stove_1", "device_type": "stove", "capacity_units": 1,
             "capabilities": {"modes": ["stir_fry"], "temperature_min_c": 60, "temperature_max_c": 250}, "available": True},
            {"device_id": "oven_1", "device_type": "oven", "capacity_units": 1,
             "capabilities": {"modes": [], "temperature_min_c": 60, "temperature_max_c": 230}, "available": True},
        ]},
        "objective": {"max_solve_time_sec": 5},
    }
    stages: list[dict] = []
    result = schedule(request, stage_diagnostics=stages)
    assert result["validation"]["valid"] is True
    assert result["solver"]["status"] in {"OPTIMAL", "FEASIBLE"}
    assert result["metrics"]["device_conflicts"] == 0
    assert result["metrics"]["dependency_violations"] == 0
    assert result["metrics"]["finish_spread_sec"] == 0
    assert result["metrics"]["makespan_sec"] == 1200
    # <=20-minute window guarantees no >3-hour idle; zero extra solve overhead.
    assert "fresh_prep_tiebreak" not in [stage["stage"] for stage in stages]


def test_optional_tiebreak_can_never_worsen_official_metrics(monkeypatch):
    """Even when eligible, the extra stage must preserve all Level-3 metrics."""
    import app.scheduler.cp_sat as cp_sat

    # Force consideration on a small deterministic fixture, independent of
    # which equally good task positions the first solve happens to select.
    monkeypatch.setattr(cp_sat, "unusually_idle_edges", lambda edges, starts, ends, solver: edges)
    request = {
        "schema_version": "1.0", "request_id": "fresh_optional_scoring",
        "tasks": [
            task("wash", "A", "洗净切碎青菜", 60, []),
            task("fry", "A", "入锅翻炒青菜", 300, ["wash"], resource_type="device", device_type="stove"),
            task("bake", "B", "放入烤箱烘烤", 1200, [], resource_type="device", device_type="oven"),
        ],
        "device_config": {"schema_version": "1.0", "operator_count": 1, "devices": [
            {"device_id": "stove_1", "device_type": "stove", "capacity_units": 1,
             "capabilities": {"modes": ["stir_fry"], "temperature_min_c": 60, "temperature_max_c": 250}, "available": True},
            {"device_id": "oven_1", "device_type": "oven", "capacity_units": 1,
             "capabilities": {"modes": [], "temperature_min_c": 60, "temperature_max_c": 230}, "available": True},
        ]},
        "objective": {"max_solve_time_sec": 5},
    }
    stages: list[dict] = []
    result = schedule(request, stage_diagnostics=stages)
    assert result["validation"]["valid"]
    assert result["metrics"]["finish_spread_sec"] == 0
    assert result["metrics"]["makespan_sec"] == 1200
    assert result["metrics"]["max_continuous_manual_sec"] == 60
    assert result["metrics"]["device_conflicts"] == 0
    assert result["metrics"]["dependency_violations"] == 0
    # On a low-power CI worker the optional stage may be skipped for budget.
    assert all(entry["remaining_ms"] <= 80.01 for entry in stages if entry["stage"] == "fresh_prep_tiebreak")
