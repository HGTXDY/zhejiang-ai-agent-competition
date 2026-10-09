"""Staged preparation must preserve task semantics and require explicit signoff."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime

import pytest

from app.catalog import get_recipe_payload
from app.parser import DeterministicParserAdapter, RecipeParser
from app.staged_planning import StagedSolveError, build_staged_plan, partition_staged_request


def _tasks(recipe_id: str) -> list[dict]:
    recipe = get_recipe_payload(recipe_id)
    return list(RecipeParser(DeterministicParserAdapter()).parse(recipe).tasks)


def _request(*groups: list[dict]) -> dict:
    return {
        'schema_version': '1.0', 'request_id': 'staged_case',
        'device_config': {'target_ready_at': '2026-10-10T12:30:00+08:00', 'operator_count': 1,
                          'schema_version': '1.0', 'devices': []},
        'tasks': [deepcopy(task) for group in groups for task in group],
    }


def _fake_solve(request: dict) -> dict:
    # Minimal deterministic solver stub: unit tests check the partition and
    # confirmation gate; actual CP-SAT validity is tested on a real OR-Tools
    # machine by backend/tests/test_staged_api.py.
    seconds = sum(t['duration_sec'] for t in request['tasks'])
    return {'schedule_id': request['request_id'] + '_schedule',
            'solver': {'status': 'OPTIMAL'}, 'validation': {'valid': True},
            'metrics': {'makespan_sec': seconds},
            'tasks': [{'task_id': t['task_id']} for t in request['tasks']]}


def test_official_24_hour_freeze_separates_without_editing_original_tasks():
    chicken = _tasks('5c8646fe98d5bc7e184a90bc')
    beef = _tasks('5c8646fe98d5bc7e184a90bc')
    # Use a unique second dish ID; duplicated task IDs would violate V1.
    for task in beef:
        old_id = task['task_id']
        task['task_id'] = 'beef_' + old_id
        task['dish_id'] = 'beef'
        task['predecessors'] = ['beef_' + item for item in task['predecessors']]
    original = _request(chicken, beef)
    before = deepcopy(original)
    part = partition_staged_request(original)
    assert part.advance_request is not None
    assert len(part.advance_task_ids) == 4
    assert any(t['duration_sec'] == 86400 for t in part.advance_request['tasks'])
    assert all(t['duration_sec'] != 86400 for t in part.main_request['tasks'])
    assert sum(len(req['tasks']) for req in (part.advance_request, part.main_request)) == len(before['tasks'])
    assert all(p in {t['task_id'] for t in part.main_request['tasks']} for t in part.main_request['tasks'] for p in t['predecessors'])
    assert original == before  # No silent removal or completed-state mutation.


def test_not_confirmed_means_preview_cannot_start_or_enter_execution():
    request = _request(_tasks('5c8646fe98d5bc7e184a90bc'))
    preview, executable = build_staged_plan(request, [], _fake_solve)
    assert preview['status'] == 'PREPARATION_REQUIRED'
    assert preview['can_start_main'] is False
    assert executable is None
    assert preview['executable_main_request'] is None
    assert preview['pending_advance_task_ids'] == preview['advance_task_ids']
    assert preview['timing']['main_makespan_sec'] < 86400
    assert preview['timing']['advance_makespan_sec'] >= 86400
    assert preview['timing']['total_elapsed_sec'] == (
        preview['timing']['advance_makespan_sec'] + preview['timing']['main_makespan_sec']
    )
    assert preview['timing']['total_elapsed_sec'] >= 86400  # No 24-hour hold disappears.
    assert preview['timing']['main_start_offset_sec'] == preview['timing']['advance_makespan_sec']
    assert preview['timing']['total_finish_offset_sec'] == preview['timing']['total_elapsed_sec']
    target = datetime.fromisoformat(preview['timing']['target_ready_at'])
    advance_start = datetime.fromisoformat(preview['timing']['suggested_advance_start_at'])
    main_start = datetime.fromisoformat(preview['timing']['suggested_main_start_at'])
    assert int((target - advance_start).total_seconds()) == preview['timing']['total_elapsed_sec']
    assert int((target - main_start).total_seconds()) == preview['timing']['main_makespan_sec']

    partial, executable = build_staged_plan(request, preview['advance_task_ids'][:1], _fake_solve)
    assert not partial['can_start_main'] and executable is None

    confirmed, executable = build_staged_plan(request, preview['advance_task_ids'], _fake_solve)
    assert confirmed['status'] == 'READY'
    assert confirmed['can_start_main']
    # Even after the user confirms completed advance work, original planning
    # history still includes the full 24-hour hold in the total.
    assert confirmed['timing']['total_elapsed_sec'] == preview['timing']['total_elapsed_sec']
    assert executable is not None
    assert confirmed['executable_main_request'] == executable
    assert len(executable['tasks']) == len(confirmed['main_schedule']['tasks'])
    assert all(t['task_id'] not in preview['advance_task_ids'] for t in executable['tasks'])


def test_overall_elapsed_uses_parallel_phase_makespans_without_erasing_cold_hold():
    # In each phase some independent tasks can run concurrently. The full
    # interval is stage makespan + stage makespan, NOT the sum of all tasks.
    request = _request(_tasks('5c8646fe98d5bc7e184a90bc'))
    def parallel_stage_stub(stage_request: dict) -> dict:
        duration = max(t['duration_sec'] for t in stage_request['tasks'])
        return {
            'schedule_id': stage_request['request_id'] + '_schedule',
            'solver': {'status': 'OPTIMAL'}, 'validation': {'valid': True},
            'metrics': {'makespan_sec': duration},
            'tasks': [{'task_id': t['task_id']} for t in stage_request['tasks']],
        }

    preview, _ = build_staged_plan(request, [], parallel_stage_stub)
    timing = preview['timing']
    assert timing['advance_makespan_sec'] >= 86400
    assert timing['total_elapsed_sec'] == (
        timing['advance_makespan_sec'] + timing['main_makespan_sec']
    )
    assert timing['total_elapsed_sec'] < sum(t['duration_sec'] for t in request['tasks'])
    assert timing['main_start_offset_sec'] == timing['advance_makespan_sec']
    assert timing['total_finish_offset_sec'] == timing['total_elapsed_sec']


def test_no_advance_returns_original_request_without_fake_completion():
    recipe = {
        'schema_version': '1.0', 'recipe_id': 'short', 'name': '短时烹饪',
        'ingredients': ['食材'], 'steps_text': ['将菜洗净切碎。', '热锅翻炒5分钟。']
    }
    tasks = list(RecipeParser(DeterministicParserAdapter()).parse(recipe).tasks)
    request = _request(tasks)
    part = partition_staged_request(request)
    assert part.advance_request is None
    assert part.main_request == request
    summary, original = build_staged_plan(request, [], _fake_solve)
    assert summary['status'] == 'READY'
    assert summary['advance_schedule'] is None
    assert summary['timing']['advance_makespan_sec'] == 0
    assert summary['timing']['total_elapsed_sec'] == summary['timing']['main_makespan_sec']
    assert summary['timing']['main_start_offset_sec'] == 0
    assert original == request


def test_ambiguous_overnight_hold_blocks_automatic_execution():
    request = _request(_tasks('65f7f4ee85eb6c79dfb992ff'))
    preview, executable = build_staged_plan(request, [], _fake_solve)
    assert preview['status'] == 'NEEDS_REVIEW'
    assert not preview['can_start_main']
    assert preview['review_required']
    assert executable is None


def test_invalid_confirmation_cannot_bypass_advance_work():
    request = _request(_tasks('5c8646fe98d5bc7e184a90bc'))
    with pytest.raises(ValueError, match='outside'):
        build_staged_plan(request, ['unknown'], _fake_solve)
    ids = partition_staged_request(request).advance_task_ids
    with pytest.raises(ValueError, match='unique'):
        build_staged_plan(request, [ids[0], ids[0]], _fake_solve)


def test_backward_dependency_forbids_staging():
    request = _request(_tasks('5c8646fe98d5bc7e184a90bc'))
    request['tasks'][0]['predecessors'] = [request['tasks'][-1]['task_id']]
    partition = partition_staged_request(request)
    assert not partition.advance_task_ids
    assert partition.review_required


def test_solver_failure_in_either_stage_does_not_return_executable_request():
    request = _request(_tasks('5c8646fe98d5bc7e184a90bc'))
    def fail_first(r: dict) -> dict:
        return {'solver': {'status': 'UNKNOWN'}, 'validation': {'valid': False}}
    with pytest.raises(StagedSolveError, match='advance'):
        build_staged_plan(request, [], fail_first)
    def fail_main(r: dict) -> dict:
        if r['request_id'].endswith('_main'):
            return {'solver': {'status': 'INFEASIBLE'}, 'validation': {'valid': False}}
        return _fake_solve(r)
    with pytest.raises(StagedSolveError, match='main'):
        build_staged_plan(request, [], fail_main)
