"""Level 4: independent event chains, immutable history and disturbance selection."""
from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path

import pytest

from app.replan import ReplanError, apply_event_to_request, replan
from app.scheduler import schedule
from scripts.benchmark_performance import _dish_added_tasks
ROOT = Path(__file__).resolve().parents[2]


def fixture_request():
    return json.loads((ROOT / 'fixtures' / 'v1' / 'four-dish-normal.json').read_text(encoding='utf-8'))


def event(event_id, schedule_id, event_type, payload):
    return {'schema_version': '1.0', 'event_id': event_id,
            'schedule_id': schedule_id, 'event_type': event_type,
            'occurred_at': '2026-10-08T00:00:00Z', 'payload': payload}


def initial():
    request = fixture_request()
    current = schedule(request)
    assert current['validation']['valid']
    return request, current


def step(request, previous, kind, payload, idx):
    envelope = {
        'schedule_request': deepcopy(request),
        'current_schedule': deepcopy(previous),
        'event': event(f'level4-{idx}', previous['schedule_id'], kind, payload),
    }
    result = replan(envelope)['schedule']
    assert result['validation']['valid'] is True
    assert result['metrics']['device_conflicts'] == 0
    assert result['metrics']['dependency_violations'] == 0
    apply_event_to_request(request, envelope['event'])
    assert {t['task_id'] for t in result['tasks']} == {t['task_id'] for t in request['tasks']}
    return result


def assert_history(before, after, task_id):
    left = next(t for t in before['tasks'] if t['task_id'] == task_id)
    right = next(t for t in after['tasks'] if t['task_id'] == task_id)
    for key in ('status', 'locked', 'start_offset_sec', 'end_offset_sec', 'assigned_resources'):
        assert right[key] == left[key], key
    assert right['status'] == 'COMPLETED'
    assert right['locked'] is True


@pytest.mark.parametrize('followup', ['TASK_DELAYED', 'DEVICE_UNAVAILABLE'])
def test_added_dish_survives_followup_and_has_real_dependencies(followup):
    request, current = initial()
    original_ids = {t['task_id'] for t in current['tasks']}
    added = _dish_added_tasks()
    current = step(request, current, 'DISH_ADDED', {'tasks': added}, 1)
    assert not original_ids.intersection(t['task_id'] for t in added)
    indexed = {t['task_id']: t for t in current['tasks']}
    assert indexed['soup_prepare']['end_offset_sec'] <= indexed['soup_simmer']['start_offset_sec']
    if followup == 'TASK_DELAYED':
        task = current['tasks'][0]
        task['status'] = 'RUNNING'
        payload = {'task_id': task['task_id'], 'delay_sec': 45}
    else:
        payload = {'device_id': 'stove_burner_1'}
    current = step(request, current, followup, payload, 2)
    assert {'soup_prepare', 'soup_simmer'} <= {t['task_id'] for t in current['tasks']}
    assert indexed['soup_prepare']['task_id'] in {t['task_id'] for t in current['tasks']}
    if followup == 'TASK_DELAYED':
        next_task = current['tasks'][0]
        next_task['status'] = 'RUNNING'
        current = step(request, current, 'TASK_DELAYED', {'task_id': next_task['task_id'], 'delay_sec': 20}, 3)
    else:
        # Third event must preserve the failed device and the previously added dish.
        extra = [dict(added[0], task_id='soup_side', dish_id='soup_side_dish', predecessors=[])]
        current = step(request, current, 'DISH_ADDED', {'tasks': extra}, 3)
        assert next(d for d in request['device_config']['devices'] if d['device_id'] == 'stove_burner_1')['available'] is False
        assert all('stove_burner_1' not in t['assigned_resources'] for t in current['tasks'])
    assert {'soup_prepare', 'soup_simmer'} <= {t['task_id'] for t in current['tasks']}


def test_failed_device_persists_before_new_dish_and_subsequent_delay():
    request, current = initial()
    current = step(request, current, 'DEVICE_UNAVAILABLE', {'device_id': 'stove_burner_1'}, 1)
    added = [dict(_dish_added_tasks()[0], task_id='third_party_prep', dish_id='third_party', predecessors=[])]
    current = step(request, current, 'DISH_ADDED', {'tasks': added}, 2)
    current['tasks'][0]['status'] = 'RUNNING'
    current = step(request, current, 'TASK_DELAYED', {'task_id': current['tasks'][0]['task_id'], 'delay_sec': 30}, 3)
    assert 'third_party_prep' in {t['task_id'] for t in current['tasks']}
    assert all('stove_burner_1' not in t['assigned_resources'] for t in current['tasks'])


@pytest.mark.parametrize('following', ['DISH_ADDED', 'TASK_DELAYED', 'DEVICE_UNAVAILABLE'])
def test_completed_history_immutable_across_events(following):
    request, current = initial()
    locked = current['tasks'][0]
    locked['status'] = 'RUNNING'
    current = step(request, current, 'TASK_COMPLETED', {'task_id': locked['task_id']}, 1)
    completed = deepcopy(current)
    if following == 'DISH_ADDED':
        current = step(request, current, following, {'tasks': _dish_added_tasks()}, 2)
        assert_history(completed, current, locked['task_id'])
        task = next(t for t in current['tasks'] if t['task_id'] == 'fish_prepare')
        task['status'] = 'RUNNING'
        current = step(request, current, 'TASK_DELAYED', {'task_id': task['task_id'], 'delay_sec': 30}, 3)
    elif following == 'TASK_DELAYED':
        task = next(t for t in current['tasks'] if t['task_id'] == 'fish_prepare')
        task['status'] = 'RUNNING'
        current = step(request, current, following, {'task_id': task['task_id'], 'delay_sec': 30}, 2)
    else:
        # Fail a device already used by unrelated completed history.
        current = step(request, current, following, {'device_id': 'stove_burner_1'}, 2)
    assert_history(completed, current, locked['task_id'])


def test_completed_device_assignment_survives_device_failure():
    request, current = initial()
    finished = next(t for t in current['tasks'] if 'stove_burner_1' in t['assigned_resources'])
    finished['status'], finished['locked'] = 'COMPLETED', True
    before = deepcopy(current)
    updated = step(request, current, 'DEVICE_UNAVAILABLE', {'device_id': 'stove_burner_1'}, 1)
    assert_history(before, updated, finished['task_id'])
    assert all('stove_burner_1' not in t['assigned_resources'] for t in updated['tasks'] if not t['locked'])
    later = step(request, updated, 'DISH_ADDED', {'tasks': _dish_added_tasks()}, 2)
    assert_history(before, later, finished['task_id'])
    assert all('stove_burner_1' not in t['assigned_resources'] for t in later['tasks'] if not t['locked'])


def test_failure_does_not_mutate_inputs_and_missing_lineage_rejected():
    request, current = initial()
    new = _dish_added_tasks()
    latest = step(request, current, 'DISH_ADDED', {'tasks': new}, 1)
    stale = fixture_request()
    snapshot = deepcopy(latest)
    with pytest.raises(ReplanError, match='lineage'):
        step(stale, latest, 'TASK_DELAYED', {'task_id': latest['tasks'][0]['task_id'], 'delay_sec': 10}, 2)
    assert latest == snapshot
    for kind, payload in [
        ('DISH_ADDED', {'tasks': [dict(new[0], task_id=new[0]['task_id'])]}),
        ('DISH_ADDED', {'tasks': [dict(new[0], task_id='dangling', predecessors=['missing'])]}),
        ('DEVICE_UNAVAILABLE', {'device_id': 'does_not_exist'}),
    ]:
        original = deepcopy(request)
        previous = deepcopy(latest)
        with pytest.raises(ReplanError):
            step(request, latest, kind, payload, f'error-{kind}')
        assert request == original
        assert latest == previous


def test_replan_specific_resource_tiebreak_never_changes_level3():
    request = fixture_request()
    # Two independent, no-manual device tasks have equal finish spread/makespan
    # for either allocation. The previous resource assignment must win the tie.
    tasks = []
    for idx in range(2):
        task = deepcopy(next(t for t in request['tasks'] if t['task_id'] == 'ribs_blanch'))
        task.update(task_id=f'choice_{idx}', dish_id=f'choice_dish_{idx}', duration_sec=60,
                    predecessors=[], resource_type='device', manual_segments=[],
                    manual_required=False, manual_duration_sec=0)
        tasks.append(task)
    request['tasks'] = tasks
    request['device_config']['devices'] = [d for d in request['device_config']['devices'] if d['device_type'] == 'stove']
    old = schedule(request)
    assert old['solver']['status'] == 'OPTIMAL'
    old_assignments = [t['assigned_resources'][0] for t in old['tasks']]
    assert len(set(old_assignments)) == 2
    previous = deepcopy(old)
    for task in previous['tasks']:
        task['assigned_resources'] = [d for d in old_assignments if d != task['assigned_resources'][0]]
    result = schedule(request, previous_schedule=previous)
    assert result['solver']['status'] == 'OPTIMAL'
    assert result['metrics']['finish_spread_sec'] == old['metrics']['finish_spread_sec']
    assert result['metrics']['makespan_sec'] == old['metrics']['makespan_sec']
    assert result['metrics']['max_continuous_manual_sec'] == old['metrics']['max_continuous_manual_sec']
    assert [t['assigned_resources'] for t in result['tasks']] == [t['assigned_resources'] for t in previous['tasks']]
    assert all(t['start_offset_sec'] == 0 for t in result['tasks'])


def test_unavailable_last_compatible_device_fails_atomically():
    request, current = initial()
    # One stove already unavailable; the second one then fails. Running
    # tasks cannot be silently scheduled back onto either failed device.
    request['device_config']['devices'][1]['available'] = False
    snapshot = deepcopy(request), deepcopy(current)
    with pytest.raises(ReplanError) as exc:
        step(request, current, 'DEVICE_UNAVAILABLE', {'device_id': 'stove_burner_1'}, 1)
    assert exc.value.code == 'SCHEDULE_INFEASIBLE'
    assert any(item['code'] == 'NO_COMPATIBLE_DEVICE' for item in exc.value.details)
    assert (request, current) == snapshot


def test_delay_contract_and_failed_event_are_stable():
    request, current = initial()
    task = current['tasks'][0]
    request_before, current_before = deepcopy(request), deepcopy(current)
    for invalid in (0, -1):
        with pytest.raises(ReplanError) as exc:
            step(request, current, 'TASK_DELAYED', {'task_id': task['task_id'], 'delay_sec': invalid}, invalid)
        assert exc.value.code in {'INVALID_INPUT', 'INVALID_STATE_TRANSITION', 'INVALID_EVENT_PAYLOAD'}
    assert (request, current) == (request_before, current_before)
    current['tasks'][0]['status'] = 'RUNNING'
    delayed = step(request, current, 'TASK_DELAYED', {'task_id': task['task_id'], 'delay_sec': 25}, 1)
    new_task = next(t for t in delayed['tasks'] if t['task_id'] == task['task_id'])
    assert new_task['start_offset_sec'] >= task['start_offset_sec'] + 25
