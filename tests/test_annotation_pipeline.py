import json
from pathlib import Path

from scripts.build_annotation_template import build_records, split_steps
from scripts.evaluate_parser import evaluate

ROOT = Path(__file__).resolve().parents[1]


def test_split_steps_removes_numbering_and_empty_chunks():
    assert split_steps("第1步：准备食材；第2步：加热。；") == ["准备食材", "加热。"]


def test_official_csv_builds_exactly_100_template_records():
    records = build_records(ROOT / "data/official/recipes_100.csv")
    assert len(records) == 100
    assert all(record["annotation_status"] == "unannotated" for record in records)
    assert all(record["source_steps"] for record in records)


def test_evaluation_uses_tolerance_and_reports_fields():
    gold = {"r1": {"recipe_id": "r1", "tasks": [{
        "task_id": "r1_t1", "duration_sec": 300, "manual_required": True,
        "manual_duration_sec": 60, "interruptible": False,
        "predecessors": [], "device_requirement": {"device_type": "stove", "mode": "fry", "temperature_c": 180}
    }]}}
    pred = {"r1": {"recipe_id": "r1", "tasks": [{
        "task_id": "r1_t1", "duration_sec": 304, "manual_required": True,
        "manual_duration_sec": 60, "interruptible": False,
        "predecessors": [], "device_requirement": {"device_type": "stove", "mode": "fry", "temperature_c": 180}
    }]}}
    report = evaluate(gold, pred, tolerance=5)
    assert report["fields"]["duration_sec"]["accuracy"] == 1.0
    assert report["failures"] == []
