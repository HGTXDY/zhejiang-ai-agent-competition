from fastapi.testclient import TestClient

from app.api import create_app

client = TestClient(create_app())


def test_agent_plan_extracts_catalog_recipes_time_people_and_devices():
    response = client.post('/agent/plan', json={'message': '今晚六点半开饭，我一个人，做苹果芒果派、香烤排骨和麻辣对虾，有一个灶、一个蒸箱和一个烤箱'})
    assert response.status_code == 200
    body = response.json()
    assert body['ready_to_confirm'] is True
    assert body['draft']['target_time'] == '18:30'
    assert body['draft']['operator_count'] == 1
    assert [item['name'] for item in body['draft']['recipes']] == ['苹果芒果派', '香烤排骨', '麻辣对虾']
    assert body['draft']['devices'] == {'stove_count': 1, 'steamer_count': 1, 'oven_count': 1}


def test_agent_plan_asks_for_missing_information_and_keeps_context():
    first = client.post('/agent/plan', json={'message': '想做苹果芒果派、香烤排骨和麻辣对虾'}).json()
    assert set(first['missing_fields']) >= {'target_time', 'operator_count'}
    second = client.post('/agent/plan', json={'message': '晚上七点，两个人，一个灶、0台蒸箱、一个烤箱', 'context': first['draft']}).json()
    assert second['ready_to_confirm'] is True
    assert len(second['draft']['recipes']) == 3


def test_agent_command_understands_delay_and_device_failure():
    tasks = [{'task_id': 't1', 'action': '蒸鲈鱼', 'dish_name': '家常鲈鱼'}]
    delayed = client.post('/agent/command', json={'message': '鲈鱼慢了十分钟', 'tasks': tasks}).json()
    assert delayed['intent'] == 'task_delayed'
    assert delayed['task_id'] == 't1'
    broken = client.post('/agent/command', json={'message': '蒸箱坏了', 'tasks': tasks}).json()
    assert broken == {'intent': 'device_unavailable', 'reply': '已识别设备异常，将重新安排。', 'device_id': 'steamer_1', 'ready': True}
