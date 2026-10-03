#!/usr/bin/env python3
"""Three-baseline performance benchmark for the competition scheduling Agent.

Measures, with wall-clock timing and warmup:

1. initial schedule — lexicographic multi-objective CP-SAT on the four-dish
   fixture (the representative multi-dish scenario);
2. dynamic replan — one TASK_COMPLETED event applied through the event-driven
   replan service (state machine + re-solve + diff);
3. end-to-end — parse -> schema/business validation -> solve -> notification
   over all 100 official recipes, reporting each stage and total wall-clock.

Each phase reports min / p50 / p95 / max in milliseconds and checks the
competition Level 5 budget gates from issue #50 (initial < 5000ms, replan
< 3000ms). Results are written to docs/evaluation/ as JSON + Markdown and are
reproducible in CI.

This is an engineering regression baseline, not an official competition score.
"""
from __future__ import annotations

import argparse
import csv
import json
import platform
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend"))

from app.parser import DeterministicParserAdapter, RecipeParser  # noqa: E402
from app.parser.deterministic import default_device_config  # noqa: E402
from app.notifications import build_key_node_plan  # noqa: E402
from app.replan import replan  # noqa: E402
from app.scheduler import schedule  # noqa: E402
from scripts.build_annotation_template import split_steps  # noqa: E402
from scripts.validate_contracts import validate_schedule_request_business_rules  # noqa: E402

DEFAULT_FIXTURE = ROOT / "fixtures" / "v1" / "four-dish-normal.json"
DEFAULT_RECIPES = ROOT / "data" / "official" / "recipes_100.csv"
SCHEMA_DIR = ROOT / "contracts" / "v1" / "schemas"

# Competition Level 5 budget gates (issue #50): initial < 5s, replan < 3s.
INITIAL_BUDGET_MS = 5000
REPLAN_BUDGET_MS = 3000


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    index = (len(ordered) - 1) * fraction
    lower, upper = int(index), min(int(index) + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower)


def summarize(samples: list[float]) -> dict[str, float]:
    return {
        "min": round(min(samples), 3),
        "p50": round(statistics.median(samples), 3),
        "p95": round(percentile(samples, 0.95), 3),
        "max": round(max(samples), 3),
    }


def git_revision() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def load_recipe_payloads(source: Path) -> list[dict[str, Any]]:
    with source.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    payloads: list[dict[str, Any]] = []
    for row in rows:
        seen: set[str] = set()
        ingredients: list[str] = []
        for part in (row.get("食材清单", "") or "").split("；"):
            item = part.strip()
            if item and item not in seen:
                seen.add(item)
                ingredients.append(item)
        payloads.append(
            {
                "schema_version": "1.0",
                "recipe_id": row["菜谱id"],
                "name": row["名称"],
                "ingredients": ingredients,
                "steps_text": split_steps(row["烹饪步骤"]),
                "source": "official",
            }
        )
    return payloads


def _schedule_request(recipe_id: str, tasks: list[dict[str, Any]], device_config: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "request_id": f"bench_{recipe_id}",
        "tasks": tasks,
        "device_config": device_config,
        "objective": {"max_solve_time_sec": 5, "manual_merge_gap_sec": 30},
    }


def measure_initial(fixture: Path, iterations: int, warmup: int) -> dict[str, Any]:
    request = json.loads(fixture.read_text(encoding="utf-8"))
    for _ in range(warmup):
        schedule(request)
    samples: list[float] = []
    statuses: list[str] = []
    for _ in range(iterations):
        started = time.perf_counter()
        result = schedule(request)
        samples.append((time.perf_counter() - started) * 1000)
        statuses.append(result["solver"]["status"])
    if any(status not in {"OPTIMAL", "FEASIBLE"} for status in statuses):
        raise RuntimeError(f"initial schedule produced non-success statuses: {statuses}")
    return {
        "scenario": str(fixture.relative_to(ROOT)),
        "iterations": iterations,
        "warmup": warmup,
        "solver_statuses": sorted(set(statuses)),
        "wall_clock_ms": summarize(samples),
        "budget_ms": INITIAL_BUDGET_MS,
        "within_budget": percentile(samples, 0.95) < INITIAL_BUDGET_MS,
    }


def measure_replan(fixture: Path, iterations: int, warmup: int) -> dict[str, Any]:
    request = json.loads(fixture.read_text(encoding="utf-8"))
    previous = schedule(request)
    previous["tasks"][0]["status"] = "RUNNING"
    previous["tasks"][1]["status"] = "PENDING"
    envelope = {
        "event": {
            "schema_version": "1.0",
            "event_id": "bench-complete-1",
            "schedule_id": previous["schedule_id"],
            "event_type": "TASK_COMPLETED",
            "occurred_at": "2026-09-27T12:00:00Z",
            "payload": {"task_id": previous["tasks"][0]["task_id"]},
        },
        "schedule_request": request,
        "current_schedule": previous,
    }
    for _ in range(warmup):
        replan(envelope)
    samples: list[float] = []
    for _ in range(iterations):
        started = time.perf_counter()
        replan(envelope)
        samples.append((time.perf_counter() - started) * 1000)
    return {
        "scenario": "TASK_COMPLETED",
        "iterations": iterations,
        "warmup": warmup,
        "wall_clock_ms": summarize(samples),
        "budget_ms": REPLAN_BUDGET_MS,
        "within_budget": percentile(samples, 0.95) < REPLAN_BUDGET_MS,
    }


def _dish_added_tasks() -> list[dict[str, Any]]:
    """A two-step 排骨汤 dish whose tasks are compatible with the four-dish fixture."""
    field_status = {
        "duration_sec": "provided",
        "device_type": "provided",
        "device_mode": "provided",
        "temperature_c": "provided",
        "manual_duration_sec": "provided",
    }
    return [
        {
            "schema_version": "1.0",
            "task_id": "soup_prepare",
            "dish_id": "pork_rib_soup",
            "action": "排骨洗净并准备炖汤料",
            "resource_type": "manual",
            "duration_sec": 240,
            "manual_segments": [],
            "predecessors": [],
            "interruptible": False,
            "confidence": 1.0,
            "source_step_index": 0,
            "manual_required": True,
            "manual_duration_sec": 240,
            "field_status": {**field_status, "device_type": "not_applicable", "device_mode": "not_applicable", "temperature_c": "not_applicable"},
        },
        {
            "schema_version": "1.0",
            "task_id": "soup_simmer",
            "dish_id": "pork_rib_soup",
            "action": "排骨汤小火慢炖",
            "resource_type": "hybrid",
            "device_requirement": {
                "device_type": "stove",
                "mode": "low_heat",
                "temperature_c": 95,
                "capacity_units": 1,
            },
            "duration_sec": 1800,
            "manual_segments": [
                {"offset_sec": 0, "duration_sec": 30, "action": "将排骨和汤料放入锅中"},
                {"offset_sec": 1770, "duration_sec": 30, "action": "出锅装汤"},
            ],
            "predecessors": ["soup_prepare"],
            "interruptible": False,
            "confidence": 1.0,
            "source_step_index": 1,
            "manual_required": True,
            "manual_duration_sec": 60,
            "field_status": field_status,
        },
    ]


def measure_replan_dish_added(fixture: Path, iterations: int, warmup: int) -> dict[str, Any]:
    request = json.loads(fixture.read_text(encoding="utf-8"))
    previous = schedule(request)
    previous["tasks"][0]["status"] = "RUNNING"
    envelope = {
        "event": {
            "schema_version": "1.0",
            "event_id": "bench-add-1",
            "schedule_id": previous["schedule_id"],
            "event_type": "DISH_ADDED",
            "occurred_at": "2026-09-27T12:00:00Z",
            "payload": {"tasks": _dish_added_tasks()},
        },
        "schedule_request": request,
        "current_schedule": previous,
    }
    for _ in range(warmup):
        replan(envelope)
    samples: list[float] = []
    for _ in range(iterations):
        started = time.perf_counter()
        replan(envelope)
        samples.append((time.perf_counter() - started) * 1000)
    return {
        "scenario": "DISH_ADDED",
        "iterations": iterations,
        "warmup": warmup,
        "wall_clock_ms": summarize(samples),
        "budget_ms": REPLAN_BUDGET_MS,
        "within_budget": percentile(samples, 0.95) < REPLAN_BUDGET_MS,
    }


def _schedule_request_validator() -> Draft202012Validator:
    schemas = {path.name: json.loads(path.read_text(encoding="utf-8")) for path in SCHEMA_DIR.glob("*.json")}
    registry = Registry().with_resources(
        (name, Resource.from_contents(schema)) for name, schema in schemas.items()
    )
    return Draft202012Validator(
        schemas["schedule-request.schema.json"],
        registry=registry,
        format_checker=FormatChecker(),
    )


def measure_end_to_end(payloads: list[dict[str, Any]], iterations: int, warmup: int) -> dict[str, Any]:
    parser = RecipeParser(DeterministicParserAdapter())
    device_config = default_device_config()
    validator = _schedule_request_validator()

    def run_once() -> tuple[dict[str, list[float]], list[str]]:
        samples = {name: [] for name in ("parse", "validation", "solve", "notification", "total")}
        statuses: list[str] = []
        for payload in payloads:
            started = time.perf_counter()
            tasks = list(parser.parse(payload).tasks)
            parsed_at = time.perf_counter()

            request = _schedule_request(payload["recipe_id"], tasks, device_config)
            schema_errors = list(validator.iter_errors(request))
            business_errors = validate_schedule_request_business_rules(request)
            validated_at = time.perf_counter()
            if schema_errors or business_errors:
                raise RuntimeError(
                    f"end-to-end validation failed for {payload['recipe_id']}: "
                    f"schema={len(schema_errors)}, business={business_errors}"
                )

            result = schedule(request, include_notifications=False)
            solved_at = time.perf_counter()
            notifications, points_by_task = build_key_node_plan(result["tasks"], tasks)
            for task in result["tasks"]:
                task["notification_points"] = points_by_task.get(task["task_id"], [])
            result["notifications"] = notifications
            notified_at = time.perf_counter()

            samples["parse"].append((parsed_at - started) * 1000)
            samples["validation"].append((validated_at - parsed_at) * 1000)
            samples["solve"].append((solved_at - validated_at) * 1000)
            samples["notification"].append((notified_at - solved_at) * 1000)
            samples["total"].append((notified_at - started) * 1000)
            statuses.append(result["solver"]["status"])
        return samples, statuses

    for _ in range(warmup):
        run_once()

    all_samples = {name: [] for name in ("parse", "validation", "solve", "notification", "total")}
    all_statuses: list[str] = []
    for _ in range(iterations):
        samples, statuses = run_once()
        for name, values in samples.items():
            all_samples[name].extend(values)
        all_statuses.extend(statuses)

    if any(status not in {"OPTIMAL", "FEASIBLE"} for status in all_statuses):
        raise RuntimeError(f"end-to-end schedule produced non-success statuses: {sorted(set(all_statuses))}")
    return {
        "recipes": len(payloads),
        "iterations": iterations,
        "warmup": warmup,
        "pipeline": ["parse", "schema_and_business_validation", "solve", "notification"],
        "solver_statuses": sorted(set(all_statuses)),
        **{f"{name}_ms": summarize(values) for name, values in all_samples.items()},
        "aggregate": {
            f"{name}_total_ms": round(sum(values), 3) for name, values in all_samples.items()
        },
    }


def _render_replan_added(added: dict[str, Any]) -> str:
    added_t = added["wall_clock_ms"]
    return f"""合格线 `{added['budget_ms']}` ms，结果 `{'通过' if added['within_budget'] else '超预算'}`。

| 指标 | 数值（毫秒） |
|---|---:|
| min | {added_t['min']} |
| p50 | {added_t['p50']} |
| p95 | {added_t['p95']} |
| max | {added_t['max']} |

预热 {added['warmup']} 次、测量 {added['iterations']} 次。
"""


def render_markdown(report: dict[str, Any]) -> str:
    initial, replan_report, end_to_end = report["initial"], report["replan"], report["end_to_end"]
    replan_added = report.get("replan_dish_added")
    init_t = initial["wall_clock_ms"]
    replan_t = replan_report["wall_clock_ms"]
    e2e = end_to_end
    return f"""# 完整性能基线报告

> 这是工程回归基线，不是浙江省大学生人工智能竞赛官方得分或官方评测结果。官方指标、数据集和评测协议以赛事文件为准。

## 运行信息

| 项目 | 值 |
|---|---|
| 生成时间 | `{report['generated_at']}` |
| Git revision | `{report['git_revision']}` |
| Python | `{report['python']}` |
| 平台 | `{report['platform']}` |
| 官方菜谱数 | `{e2e['recipes']}` |

## 1. 初始排程耗时（四道菜 fixture，多目标分层 CP-SAT）

合格线 `{initial['budget_ms']}` ms，结果 `{'通过' if initial['within_budget'] else '超预算'}`。

| 指标 | 数值（毫秒） |
|---|---:|
| min | {init_t['min']} |
| p50 | {init_t['p50']} |
| p95 | {init_t['p95']} |
| max | {init_t['max']} |

Solver 状态：`{', '.join(initial['solver_statuses'])}`；预热 {initial['warmup']} 次、测量 {initial['iterations']} 次。

## 2. 动态重排耗时（TASK_COMPLETED 事件）

合格线 `{replan_report['budget_ms']}` ms，结果 `{'通过' if replan_report['within_budget'] else '超预算'}`。

| 指标 | 数值（毫秒） |
|---|---:|
| min | {replan_t['min']} |
| p50 | {replan_t['p50']} |
| p95 | {replan_t['p95']} |
| max | {replan_t['max']} |

预热 {replan_report['warmup']} 次、测量 {replan_report['iterations']} 次。

{"## 2b. 动态重排耗时（DISH_ADDED 临时加菜事件）" if replan_added else ""}

{_render_replan_added(replan_added) if replan_added else ""}
## 3. 端到端耗时（解析 → Schema/业务校验 → 求解 → 通知，100 道官方菜谱）

单道菜谱耗时分布（毫秒）：

| 阶段 | min | p50 | p95 | max |
|---|---:|---:|---:|---:|
| 解析 | {e2e['parse_ms']['min']} | {e2e['parse_ms']['p50']} | {e2e['parse_ms']['p95']} | {e2e['parse_ms']['max']} |
| Schema + 业务校验 | {e2e['validation_ms']['min']} | {e2e['validation_ms']['p50']} | {e2e['validation_ms']['p95']} | {e2e['validation_ms']['max']} |
| 求解 | {e2e['solve_ms']['min']} | {e2e['solve_ms']['p50']} | {e2e['solve_ms']['p95']} | {e2e['solve_ms']['max']} |
| 通知 | {e2e['notification_ms']['min']} | {e2e['notification_ms']['p50']} | {e2e['notification_ms']['p95']} | {e2e['notification_ms']['max']} |
| 合计 | {e2e['total_ms']['min']} | {e2e['total_ms']['p50']} | {e2e['total_ms']['p95']} | {e2e['total_ms']['max']} |

100 道菜批量总计（{e2e['iterations']} 轮累计）：解析 {e2e['aggregate']['parse_total_ms']} ms，校验 {e2e['aggregate']['validation_total_ms']} ms，求解 {e2e['aggregate']['solve_total_ms']} ms，通知 {e2e['aggregate']['notification_total_ms']} ms，端到端 {e2e['aggregate']['total_total_ms']} ms。Solver 状态：`{', '.join(e2e['solver_statuses'])}`。

## 复现命令

```bash
PYTHONPATH=backend:. python scripts/benchmark_performance.py \\
  --initial-iterations 20 --initial-warmup 2 \\
  --replan-iterations 20 --replan-warmup 2 \\
  --e2e-iterations 5 --e2e-warmup 1 \\
  --json-out docs/evaluation/performance-baseline-full.json \\
  --markdown-out docs/evaluation/performance-baseline-full.md
```

CI 中可用 `--fail-on-budget` 以合格线作为硬门槛。
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--recipes", type=Path, default=DEFAULT_RECIPES)
    parser.add_argument("--initial-iterations", type=int, default=20)
    parser.add_argument("--initial-warmup", type=int, default=2)
    parser.add_argument("--replan-iterations", type=int, default=20)
    parser.add_argument("--replan-warmup", type=int, default=2)
    parser.add_argument("--e2e-iterations", type=int, default=5)
    parser.add_argument("--e2e-warmup", type=int, default=1)
    parser.add_argument("--json-out", type=Path, default=ROOT / "docs/evaluation/performance-baseline-full.json")
    parser.add_argument("--markdown-out", type=Path, default=ROOT / "docs/evaluation/performance-baseline-full.md")
    parser.add_argument("--fail-on-budget", action="store_true")
    args = parser.parse_args()

    fixture = args.fixture if args.fixture.is_absolute() else ROOT / args.fixture
    recipes = args.recipes if args.recipes.is_absolute() else ROOT / args.recipes
    payloads = load_recipe_payloads(recipes)

    initial = measure_initial(fixture, args.initial_iterations, args.initial_warmup)
    replan_report = measure_replan(fixture, args.replan_iterations, args.replan_warmup)
    replan_added = measure_replan_dish_added(fixture, args.replan_iterations, args.replan_warmup)
    end_to_end = measure_end_to_end(payloads, args.e2e_iterations, args.e2e_warmup)

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "git_revision": git_revision(),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "initial": initial,
        "replan": replan_report,
        "replan_dish_added": replan_added,
        "end_to_end": end_to_end,
    }
    args.json_out.parent.mkdir(parents=True, exist_ok=True)
    args.markdown_out.parent.mkdir(parents=True, exist_ok=True)
    args.json_out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.markdown_out.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if args.fail_on_budget and not (
        initial["within_budget"]
        and replan_report["within_budget"]
        and replan_added["within_budget"]
    ):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
