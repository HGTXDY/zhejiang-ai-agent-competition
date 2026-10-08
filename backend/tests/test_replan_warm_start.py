"""Replan-only warm starts preserve the Level 3 lexicographic optimization."""
from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path

from app.replan import replan
from app.scheduler import SchedulerConfig, schedule

ROOT = Path(__file__).resolve().parents[2]


def compact_case():
    fixture = json.loads((ROOT / 'fixtures' / 'v1' / 'four-dish-normal.json').read_text(encoding='utf-8'))
    original = deepcopy(fixture)
    original['tasks'] = [deepcopy(task) for task in fixture['tasks']
                         if task['task_id'] in ('ribs_prepare', 'ribs_blanch')]
    added = deepcopy(next(task for task in fixture['tasks'] if task['task_id'] == 'fish_prepare'))
    previous = schedule(original)
    assert previous['solver']['status'] == 'OPTIMAL'
    updated = deepcopy(original)
    updated['tasks'].append(added)
    return original, previous, updated, added


def test_previous_replan_hints_and_stage_incumbents_are_present():
    _, previous, updated, added = compact_case()
    stages = []
    result = schedule(updated, previous_schedule=previous, stage_diagnostics=stages)
    assert result['validation']['valid']
    assert {task['task_id'] for task in result['tasks']} == {task['task_id'] for task in updated['tasks']}
    assert result['solver']['status'] == 'OPTIMAL'
    assert [row['stage'] for row in stages][:3] == ['finish_spread', 'makespan', 'continuous_manual']
    assert stages[0]['hint_count'] > 0  # the two original tasks, not the added dish
    assert stages[1]['hint_count'] > stages[0]['hint_count']  # full incumbent from stage 1
    assert stages[2]['hint_count'] >= stages[1]['hint_count']
    assert any(row['stage'] == 'start_displacement' for row in stages)
    assert added['task_id'] in {task['task_id'] for task in result['tasks']}


def test_warm_start_keeps_level3_optima_and_initial_schedule_is_hint_free():
    _, previous, updated, _ = compact_case()
    no_hints = SchedulerConfig(enable_replan_warm_start=False)
    base_stages = []
    base = schedule(updated, config=no_hints, previous_schedule=previous, stage_diagnostics=base_stages)
    warmed = schedule(updated, previous_schedule=previous)
    assert all(row['hint_count'] == 0 for row in base_stages)
    assert base['solver']['status'] == warmed['solver']['status'] == 'OPTIMAL'
    for name in ('finish_spread_sec', 'makespan_sec', 'max_continuous_manual_sec'):
        assert base['metrics'][name] == warmed['metrics'][name]
    assert warmed['metrics']['device_conflicts'] == 0
    assert warmed['metrics']['dependency_violations'] == 0
    first_stages = []
    first = schedule(updated, stage_diagnostics=first_stages)
    assert first['validation']['valid']
    assert all(row['hint_count'] == 0 for row in first_stages)


def test_stage_profiling_does_not_change_replan_response_contract():
    original, previous, _, new_task = compact_case()
    envelope = {
        'event': {'schema_version': '1.0', 'event_id': 'bench-profile-1',
                  'schedule_id': previous['schedule_id'], 'event_type': 'DISH_ADDED',
                  'occurred_at': '2026-10-08T00:00:00Z', 'payload': {'tasks': [new_task]}},
        'schedule_request': original,
        'current_schedule': previous,
    }
    stages = []
    result = replan(envelope, stage_diagnostics=stages)
    assert result['schedule']['validation']['valid']
    assert stages and stages[0]['stage'] == 'finish_spread'
    assert 'stage_timings' not in result
    assert 'stage_timings' not in result['schedule']
    assert len(result['schedule']['tasks']) == 3
