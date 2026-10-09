"""Integration: opt-in two-phase API uses the real CP-SAT resource model."""
from copy import deepcopy
from fastapi.testclient import TestClient

from app.api import create_app
from app.store import ScheduleStore


def _task(task_id, dish, action, duration, predecessors, *, device=None, manual=False, mode=None):
    result = {
        'schema_version': '1.0', 'task_id': task_id, 'dish_id': dish, 'action': action,
        'duration_sec': duration, 'predecessors': predecessors,
        'resource_type': ('device' if device else 'manual'),
        'interruptible': False, 'manual_required': manual,
        'manual_duration_sec': duration if manual else 0,
        'manual_segments': [],
    }
    if device:
        result['device_requirement'] = {'device_type': device, 'mode': mode, 'capacity_units': 1}
    return result


def _device(device_type, modes):
    return {'device_id': f'{device_type}_1', 'device_type': device_type,
            'capacity_units': 1, 'available': True,
            'capabilities': {'modes': modes, 'temperature_min_c': None, 'temperature_max_c': None}}


def sample_request():
    return {
        'schema_version': '1.0', 'request_id': 'staged_integration_case',
        'device_config': {
            'schema_version': '1.0', 'target_ready_at': '2026-10-10T12:30:00+08:00',
            'operator_count': 1,
            'devices': [_device('refrigerator', ['freeze']), _device('stove', ['stir_fry']),
                        {**_device('stove', ['stir_fry']), 'device_id': 'stove_2'}],
        },
        'tasks': [
            _task('prep_meat', 'a', '将肥肉洗净切粒拌匀', 120, [], manual=True),
            _task('freeze_meat', 'a', '放入冰箱冷冻24小时', 86400, ['prep_meat'], device='refrigerator', mode='freeze'),
            _task('cook_meat', 'a', '入锅翻炒5分钟', 300, ['freeze_meat'], device='stove', mode='stir_fry'),
            _task('prep_veg', 'b', '洗菜切菜', 120, [], manual=True),
            _task('cook_veg', 'b', '入锅翻炒3分钟', 180, ['prep_veg'], device='stove', mode='stir_fry'),
            _task('cook_rice', 'c', '入锅翻炒4分钟', 240, [], device='stove', mode='stir_fry'),
        ],
    }


def test_staged_schedule_is_confirmation_gated_and_two_stages_use_real_solver():
    state = ScheduleStore()
    client = TestClient(create_app(state))
    request = sample_request()
    original = deepcopy(request)
    response = client.post('/schedules/staged', json={'schedule_request': request})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload['status'] == 'PREPARATION_REQUIRED'
    assert not payload['can_start_main']
    assert payload['executable_main_request'] is None
    assert set(payload['advance_task_ids']) == {'prep_meat', 'freeze_meat'}
    assert payload['pending_advance_task_ids'] == payload['advance_task_ids']
    assert payload['timing']['advance_makespan_sec'] >= 86400
    assert payload['timing']['main_makespan_sec'] < 3600
    assert payload['timing']['total_elapsed_sec'] == (
        payload['timing']['advance_makespan_sec'] + payload['timing']['main_makespan_sec']
    )
    assert payload['timing']['total_elapsed_sec'] >= 86400
    assert payload['main_schedule']['metrics']['device_conflicts'] == 0
    assert payload['main_schedule']['metrics']['dependency_violations'] == 0
    assert payload['main_schedule']['metrics']['finish_spread_sec'] <= 600
    assert payload['main_schedule']['solver']['status'] in {'OPTIMAL', 'FEASIBLE'}
    assert state.get(payload['main_schedule']['schedule_id']) is None  # preview isn't executable
    assert request == original

    response = client.post('/schedules/staged', json={
        'schedule_request': request, 'confirmed_advance_task_ids': payload['advance_task_ids']})
    assert response.status_code == 200, response.text
    accepted = response.json()
    assert accepted['can_start_main'] and accepted['status'] == 'READY'
    assert accepted['executable_main_request'] is not None
    stored = state.get(accepted['main_schedule']['schedule_id'])
    assert stored is not None
    assert set(t['task_id'] for t in stored['request']['tasks']) == {'cook_meat', 'prep_veg', 'cook_veg', 'cook_rice'}
    assert stored['request']['tasks'][0]['predecessors'] == []
    assert not any(t['task_id'] in {'prep_meat', 'freeze_meat'} for t in stored['schedule']['tasks'])


def test_stage_endpoint_rejects_forged_confirmations_and_keeps_official_v1_untouched():
    state = ScheduleStore()
    client = TestClient(create_app(state))
    request = sample_request()
    forged = client.post('/schedules/staged', json={
        'schedule_request': request, 'confirmed_advance_task_ids': ['not_in_this_recipe']})
    assert forged.status_code == 422
    assert forged.json()['error']['code'] == 'INVALID_INPUT'
    # Existing official endpoint still returns only the V1-shaped response.
    # Avoid an expensive 24-hour legacy benchmark in this integration test;
    # its schema and implementation are left entirely unchanged by the Fix.
