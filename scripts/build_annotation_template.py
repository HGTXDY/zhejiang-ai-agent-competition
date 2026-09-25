"""Build a reviewable annotation template from the immutable official CSV."""
from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "data/official/recipes_100.csv"
DEFAULT_OUTPUT = ROOT / "data/annotations/templates/recipes_100.jsonl"
STEP_PREFIX = re.compile(r"^第\s*(\d+)\s*步\s*[：:、.]?\s*")


def split_steps(raw: str) -> list[str]:
    steps = []
    for chunk in raw.replace("\r\n", "\n").split("；"):
        text = chunk.strip().strip(";")
        if not text:
            continue
        text = STEP_PREFIX.sub("", text).strip()
        if text:
            steps.append(text)
    return steps


def build_records(source: Path) -> list[dict]:
    with source.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    required = {"菜谱id", "名称", "烹饪步骤"}
    if not rows or not required.issubset(rows[0]):
        raise ValueError(f"CSV must contain {sorted(required)}")
    records = []
    for row_number, row in enumerate(rows, start=2):
        steps = split_steps(row["烹饪步骤"])
        if not steps:
            raise ValueError(f"recipe {row['菜谱id']} has no steps")
        records.append(
            {
                "recipe_id": row["菜谱id"],
                "name": row["名称"],
                "source_row": row_number,
                "source_steps": [{"index": i, "text": text} for i, text in enumerate(steps)],
                "annotation_status": "unannotated",
                "tasks": [],
                "review": {
                    "required": True,
                    "notes": ["等待人工标注：设备、模式、温度、时长、依赖和人工操作字段"],
                    "low_confidence_fields": [],
                },
            }
        )
    return records


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    records = build_records(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    print(json.dumps({"records": len(records), "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
