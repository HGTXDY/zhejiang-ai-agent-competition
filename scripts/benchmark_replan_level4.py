#!/usr/bin/env python3
"""Level 4 replan benchmark with stage profiling and baseline-vs-hints quality.

Usage: PYTHONPATH=backend:. python scripts/benchmark_replan_level4.py --iterations 10 --warmup 1
The baseline uses the exact same model, objectives and five-second deadline,
with replan warm starts disabled; it never modifies official benchmark files.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from time import perf_counter
from typing import Any

from app.replan import replan
from app.scheduler import SchedulerConfig, schedule
from scripts.benchmark_performance import _dish_added_tasks, summarize

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'fixtures' / 'v1' / 'four-dish-normal.json'
QUALITY_KEYS = ('finish_spread_sec', 'makespan_sec', 'max_continuous_manual_sec',
                'device_conflicts', 'dependency_violations')


def make_case(kind: str) -> dict:
    request = json.loads(FIXTURE.read_text(encoding='utf-8'))
    previous = schedule(request)
    assert previous['validation']['valid'] and previous['solver']['status'] in {'OPTIMAL', 'FEASIBLE'}
    if kind == 'TASK_DELAYED':
        previous['tasks'][0]['status'] = 'RUNNING'
        payload = {'task_id': previous['tasks'][0]['task_id'], 'delay_sec': 60}
    elif kind == 'TASK_COMPLETED':
        previous['tasks'][0]['status'] = 'RUNNING'
        payload = {'task_id': previous['tasks'][0]['task_id']}
    elif kind == 'DEVICE_UNAVAILABLE':
        payload = {'device_id': 'stove_burner_1'}
    else:
        payload = {'tasks': _dish_added_tasks()}
    return {
        'event': {'schema_version': '1.0', 'event_id': f'benchmark_{kind}',
                  'schedule_id': previous['schedule_id'], 'event_type': kind,
                  'occurred_at': '2026-10-08T00:00:00Z', 'payload': payload},
        'schedule_request': request, 'current_schedule': previous,
    }


def measure(kind: str, iterations: int, warmup: int, *, warm_start: bool = True) -> dict[str, Any]:
    envelope = make_case(kind)
    config = SchedulerConfig(enable_replan_warm_start=warm_start)
    for _ in range(warmup):
        replan(envelope, scheduler_config=config)
    samples: list[float] = []
    solve: list[float] = []
    statuses: list[str] = []
    metrics: dict[str, list[float]] = {key: [] for key in QUALITY_KEYS}
    disruption: list[float] = []
    disturbance: dict[str, list[float]] = {}
    stage_samples: dict[str, list[dict[str, Any]]] = {}
    for _ in range(iterations):
        stages: list[dict[str, Any]] = []
        started = perf_counter()
        response = replan(envelope, scheduler_config=config, stage_diagnostics=stages)
        samples.append((perf_counter() - started) * 1000)
        solution = response['schedule']
        solve.append(solution['solver']['duration_ms'])
        statuses.append(solution['solver']['status'])
        assert solution['validation']['valid'], solution['validation']['errors']
        for key in QUALITY_KEYS:
            metrics[key].append(float(solution['metrics'][key]))
        assert solution['metrics']['device_conflicts'] == 0
        assert solution['metrics']['dependency_violations'] == 0
        disruption.append(float(response['disruption_score']))
        for key, value in response['disruption_metrics'].items():
            if isinstance(value, (int, float)):
                disturbance.setdefault(key, []).append(float(value))
        for stage in stages:
            stage_samples.setdefault(stage['stage'], []).append(stage)
    stage_report = {
        name: {
            'solve_ms': summarize([sample['solve_ms'] for sample in values]),
            'prepare_ms': summarize([sample['prepare_ms'] for sample in values]),
            'statuses': sorted({sample['status'] for sample in values}),
            'hint_count': sorted({sample['hint_count'] for sample in values}),
            'runs': len(values),
        }
        for name, values in stage_samples.items()
    }
    result: dict[str, Any] = {
        'scenario': kind,
        'warm_start': warm_start,
        'wall_clock_ms': summarize(samples),
        'solver_ms': summarize(solve),
        'solver_statuses': sorted(set(statuses)),
        'stage_timings': stage_report,
        'quality': {key: {'min': min(values), 'max': max(values), 'p50': summarize(values)['p50']}
                    for key, values in metrics.items()},
        'disruption_score': summarize(disruption),
        'disruption_metrics': {key: summarize(values) for key, values in disturbance.items()},
        'iterations': iterations,
        'warmup': warmup,
    }
    result['within_excellent'] = result['wall_clock_ms']['p95'] < 3000
    result['within_qualified'] = result['wall_clock_ms']['p95'] < 8000
    return result


def compare(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    return {
        'p95_improvement_ms': round(before['wall_clock_ms']['p95'] - after['wall_clock_ms']['p95'], 3),
        'p95_under_3000ms': after['wall_clock_ms']['p95'] < 3000,
        'level3_delta_p50': {
            key: round(after['quality'][key]['p50'] - before['quality'][key]['p50'], 3)
            for key in QUALITY_KEYS[:3]
        },
        'disruption_score_delta_p50': round(
            after['disruption_score']['p50'] - before['disruption_score']['p50'], 3
        ),
        'baseline_statuses': before['solver_statuses'],
        'optimized_statuses': after['solver_statuses'],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--iterations', type=int, default=10)
    parser.add_argument('--warmup', type=int, default=1)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--skip-baseline', action='store_true', help='Only time optimized runs')
    args = parser.parse_args()
    if args.iterations < 1 or args.warmup < 0:
        parser.error('iterations must be positive and warmup non-negative')
    # Baseline first so 'before' and 'after' refer to the same code and fixture,
    # not a guess extrapolated from a previous machine/benchmark session.
    report = {}
    if not args.skip_baseline:
        report['DISH_ADDED_baseline'] = measure('DISH_ADDED', args.iterations, args.warmup, warm_start=False)
    for kind in ('TASK_COMPLETED', 'TASK_DELAYED', 'DEVICE_UNAVAILABLE', 'DISH_ADDED'):
        report[kind] = measure(kind, args.iterations, args.warmup)
    if not args.skip_baseline:
        report['DISH_ADDED_comparison'] = compare(report['DISH_ADDED_baseline'], report['DISH_ADDED'])
    report_json = json.dumps(report, ensure_ascii=False, indent=2)
    print(report_json)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report_json + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
