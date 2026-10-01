"""Parse the official 100 recipes and run parse -> validate -> schedule end to end.

The parser boundary uses `app.parser.DeterministicParserAdapter`, a reproducible
rule-based baseline. Each recipe is parsed to V1 tasks, validated against the
task schema, assembled into a schedule request and solved. Results are written as
a predictions JSONL (compatible with `scripts/evaluate_parser.py`) plus a JSON
coverage report that honestly records provenance and strict-mode blocking.

Run from the repository root with the backend on PYTHONPATH, e.g.:

    PYTHONPATH=backend python scripts/parse_official_recipes.py
"""
from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from app.parser import DeterministicParserAdapter, RecipeParser
from app.parser.adapter import InputRecipeError, ParsedTaskError
from app.parser.deterministic import default_device_config
from app.scheduler import schedule
from scripts.build_annotation_template import split_steps
from scripts.validate_contracts import validate_schedule_request_business_rules

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "data" / "official" / "recipes_100.csv"
DEFAULT_OUTPUT_DIR = ROOT / "data" / "annotations" / "predictions"
SCHEMA_DIR = ROOT / "contracts" / "v1" / "schemas"


def _request_schema_validator() -> Draft202012Validator:
    schemas = {path.name: json.loads(path.read_text(encoding="utf-8")) for path in SCHEMA_DIR.glob("*.json")}
    registry = Registry().with_resources((name, Resource.from_contents(schema)) for name, schema in schemas.items())
    return Draft202012Validator(schemas["schedule-request.schema.json"], registry=registry, format_checker=FormatChecker())


REQUEST_VALIDATOR = _request_schema_validator()


def _schema_error_codes(request: dict[str, Any]) -> list[str]:
    errors = sorted(REQUEST_VALIDATOR.iter_errors(request), key=lambda error: list(error.absolute_path))
    return [f"{'.'.join(str(part) for part in error.absolute_path) or '$'}: {error.message}" for error in errors]


def _recipe_payload(recipe_id: str, name: str, ingredients: str, steps_text: list[str]) -> dict[str, Any]:
    # The recipe schema requires uniqueItems; official rows repeat an ingredient
    # when it is used in two stages, so dedupe while preserving order.
    seen: set[str] = set()
    unique_ingredients: list[str] = []
    for part in ingredients.split("；"):
        item = part.strip()
        if item and item not in seen:
            seen.add(item)
            unique_ingredients.append(item)
    return {
        "schema_version": "1.0",
        "recipe_id": recipe_id,
        "name": name,
        "ingredients": unique_ingredients,
        "steps_text": steps_text,
        "source": "official",
    }


def _field_status_totals(tasks: list[dict[str, Any]]) -> Counter:
    totals: Counter = Counter()
    for task in tasks:
        for field, status in (task.get("field_status") or {}).items():
            totals[(field, status)] += 1
    return totals


def parse_and_schedule(
    payloads: list[dict[str, Any]], *, strict: bool, max_solve_time_sec: int
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    parser = RecipeParser(DeterministicParserAdapter(strict=strict))
    device_config = default_device_config()
    predictions: list[dict[str, Any]] = []
    status_totals: Counter = Counter()
    failed: list[dict[str, str]] = []

    for payload in payloads:
        recipe_id = payload["recipe_id"]
        try:
            result = parser.parse(payload)
        except (InputRecipeError, ParsedTaskError) as error:
            failed.append({"recipe_id": recipe_id, "reason": str(error)})
            continue

        tasks = list(result.tasks)
        status_totals.update(_field_status_totals(tasks))
        request = {
            "schema_version": "1.0",
            "request_id": f"parse_{recipe_id}",
            "tasks": tasks,
            "device_config": device_config,
            "objective": {"max_solve_time_sec": max_solve_time_sec, "manual_merge_gap_sec": 30},
        }
        schema_errors = _schema_error_codes(request)
        if schema_errors:
            schedule_status = "SCHEMA_INVALID"
            business_errors: list[str] = []
            metrics: dict[str, Any] = {}
        else:
            business_errors = validate_schedule_request_business_rules(request)
            if business_errors:
                schedule_status = "REJECTED"
                metrics = {}
            else:
                response = schedule(request)
                schedule_status = response["solver"]["status"]
                metrics = {
                    "makespan_sec": response["metrics"]["makespan_sec"],
                    "finish_spread_sec": response["metrics"]["finish_spread_sec"],
                    "max_continuous_manual_sec": response["metrics"]["max_continuous_manual_sec"],
                }
        predictions.append(
            {
                "recipe_id": recipe_id,
                "name": payload["name"],
                "provider": result.provider,
                "tasks": tasks,
                "schedule_status": schedule_status,
                "schema_errors": schema_errors,
                "business_errors": business_errors,
                "metrics": metrics,
            }
        )

    report = {
        "strict": strict,
        "recipes_total": len(payloads),
        "parsed_ok": len(predictions),
        "parse_failed": len(failed),
        "failed": failed,
        "schema_invalid": sum(1 for item in predictions if item["schedule_status"] == "SCHEMA_INVALID"),
        "schedule_status": dict(Counter(item["schedule_status"] for item in predictions)),
        "field_status": {f"{field}.{status}": count for (field, status), count in sorted(status_totals.items())},
    }
    return predictions, report


def main() -> None:
    argparse_parser = argparse.ArgumentParser()
    argparse_parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    argparse_parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    argparse_parser.add_argument("--strict", action="store_true")
    argparse_parser.add_argument("--max-solve-time-sec", type=int, default=5)
    args = argparse_parser.parse_args()

    with args.source.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    payloads = [
        _recipe_payload(row["菜谱id"], row["名称"], row.get("食材清单", ""), split_steps(row["烹饪步骤"]))
        for row in rows
    ]
    predictions, report = parse_and_schedule(
        payloads, strict=args.strict, max_solve_time_sec=args.max_solve_time_sec
    )

    # Strict-mode blocking count, independent of the main run, for the report.
    strict_predictions, strict_report = parse_and_schedule(
        payloads, strict=True, max_solve_time_sec=args.max_solve_time_sec
    )
    report["strict_blocks"] = strict_report["parse_failed"]

    args.output_dir.mkdir(parents=True, exist_ok=True)
    predictions_path = args.output_dir / "recipes_100.jsonl"
    report_path = args.output_dir / "coverage.json"
    with predictions_path.open("w", encoding="utf-8") as handle:
        for record in predictions:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    summary = {
        "recipes_total": report["recipes_total"],
        "parsed_ok": report["parsed_ok"],
        "parse_failed": report["parse_failed"],
        "strict_blocks": report["strict_blocks"],
        "schedule_status": report["schedule_status"],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
