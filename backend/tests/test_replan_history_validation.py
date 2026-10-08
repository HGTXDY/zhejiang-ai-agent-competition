"""Historical device use remains valid after failure; mutable use does not.

This validator-level test deliberately has no CP-SAT dependency.
"""
import copy
import json
from pathlib import Path

from app.validation import validate_schedule_request, validate_schedule_result


ROOT = Path(__file__).resolve().parents[2]


def fixture():
    return json.loads((ROOT / 'fixtures/v1/four-dish-normal.json').read_text(encoding='utf-8'))


def serial_result(request):
    tasks = []
    offset = 0
    for definition in request['tasks']:
        required = definition.get('device_requirement')
        assigned = []
        if required:
            device = next(device for device in request['device_config']['devices']
                          if device['device_type'] == required['device_type']
                          and required.get('mode') in device['capabilities']['modes'])
            assigned.append(device['device_id'])
        if definition['manual_required']:
            assigned.append('operator_1')
        tasks.append({
            'task_id': definition['task_id'], 'dish_id': definition['dish_id'],
            'start_offset_sec': offset, 'end_offset_sec': offset + definition['duration_sec'],
            'assigned_resources': assigned,
            'status': 'COMPLETED' if definition['task_id'] == 'fish_steam' else 'PENDING',
            'locked': definition['task_id'] == 'fish_steam',
            'notification_points': [],
        })
        offset += definition['duration_sec']
    return {
        'schema_version': '1.0', 'request_id': request['request_id'], 'schedule_id': 'test_schedule',
        'solver': {'status': 'OPTIMAL', 'objective_value': offset, 'best_bound': offset, 'gap': 0, 'duration_ms': 0},
        'metrics': {'makespan_sec': offset, 'finish_spread_sec': 0, 'max_continuous_manual_sec': 0,
                    'device_conflicts': 0, 'dependency_violations': 0, 'target_delay_sec': 0,
                    'serial_baseline_sec': offset, 'makespan_compression_ratio': 1},
        'tasks': tasks,
        'validation': {'valid': True, 'errors': []},
        'timings_ms': {'parse': 0, 'validation': 0, 'solve': 0, 'notification': 0, 'total': 0},
        'notifications': [],
    }


def test_completed_steamer_task_survives_later_steamer_failure():
    request = fixture()
    result = serial_result(request)
    broken = copy.deepcopy(request)
    next(d for d in broken['device_config']['devices'] if d['device_id'] == 'steamer_1')['available'] = False
    assert not validate_schedule_request(broken).valid
    historical = frozenset({'fish_steam'})
    assert validate_schedule_request(broken, historical_task_ids=historical).valid
    check = validate_schedule_result(broken, result, historical_task_ids=historical)
    assert check.valid, check.as_dict()
    assert not validate_schedule_result(broken, result).valid


def test_future_use_of_failed_device_is_still_rejected():
    request = fixture()
    result = serial_result(request)
    next(d for d in request['device_config']['devices'] if d['device_id'] == 'steamer_1')['available'] = False
    future = next(t for t in result['tasks'] if t['task_id'] == 'ribs_braise')
    future['assigned_resources'] = ['steamer_1', 'operator_1']
    result['validation']['valid'] = True
    check = validate_schedule_result(request, result, historical_task_ids=frozenset({'fish_steam'}))
    assert not check.valid
    assert any(error.code == 'RESOURCE_CAPABILITY_MISMATCH' for error in check.errors)
