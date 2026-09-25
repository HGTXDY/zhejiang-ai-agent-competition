"""Field-level evaluation for parser predictions against reviewed annotations."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

FIELDS = (
    "device_type",
    "mode",
    "temperature_c",
    "duration_sec",
    "predecessors",
    "manual_required",
    "manual_duration_sec",
    "interruptible",
)


def load_jsonl(path: Path) -> dict[str, dict[str, Any]]:
    records = {}
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            record = json.loads(line)
            recipe_id = record.get("recipe_id")
            if not recipe_id or recipe_id in records:
                raise ValueError(f"invalid or duplicate recipe_id at line {line_number}")
            records[recipe_id] = record
    return records


def _task_by_id(record: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {task["task_id"]: task for task in record.get("tasks", [])}


def _field(task: dict[str, Any], field: str) -> Any:
    if field == "device_type":
        return task.get("device_requirement", {}).get("device_type")
    if field == "mode":
        return task.get("device_requirement", {}).get("mode")
    return task.get(field)


def _equal(field: str, expected: Any, actual: Any, tolerance: int) -> bool:
    if field in {"temperature_c", "duration_sec", "manual_duration_sec"}:
        if expected is None or actual is None:
            return expected == actual
        return abs(expected - actual) <= tolerance
    if field == "predecessors":
        return set(expected or []) == set(actual or [])
    return expected == actual


def evaluate(gold: dict[str, dict[str, Any]], predictions: dict[str, dict[str, Any]], tolerance: int = 5) -> dict[str, Any]:
    recipe_ids = sorted(set(gold) | set(predictions))
    field_stats = {field: {"correct": 0, "total": 0, "accuracy": 0.0} for field in FIELDS}
    failures = []
    for recipe_id in recipe_ids:
        gold_tasks = _task_by_id(gold.get(recipe_id, {}))
        prediction_tasks = _task_by_id(predictions.get(recipe_id, {}))
        for task_id, expected_task in gold_tasks.items():
            actual_task = prediction_tasks.get(task_id, {})
            for field in FIELDS:
                expected = _field(expected_task, field)
                actual = _field(actual_task, field)
                stat = field_stats[field]
                stat["total"] += 1
                if _equal(field, expected, actual, tolerance):
                    stat["correct"] += 1
                else:
                    failures.append({"recipe_id": recipe_id, "task_id": task_id, "field": field, "expected": expected, "actual": actual})
        for task_id in sorted(set(prediction_tasks) - set(gold_tasks)):
            failures.append({"recipe_id": recipe_id, "task_id": task_id, "field": "task_id", "expected": "absent", "actual": "unexpected"})
    for stat in field_stats.values():
        stat["accuracy"] = stat["correct"] / stat["total"] if stat["total"] else 0.0
    return {"recipes": len(recipe_ids), "fields": field_stats, "failures": failures}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gold", type=Path, required=True)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--tolerance-sec", type=int, default=5)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = evaluate(load_jsonl(args.gold), load_jsonl(args.predictions), args.tolerance_sec)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"recipes": report["recipes"], "failure_count": len(report["failures"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
