"""Phase hints are intentionally separate from V1 schedule task semantics."""
from __future__ import annotations

from app.catalog import get_recipe_payload, _load_recipes
from app.parser import DeterministicParserAdapter, RecipeParser
from app.preparation_phases import classify_preparation_phases


def parse_steps(recipe_id: str, steps: list[str]) -> list[dict]:
    recipe = {
        "schema_version": "1.0", "recipe_id": recipe_id, "name": "测试菜", "ingredients": ["食材"],
        "steps_text": steps, "source": "test",
    }
    return list(RecipeParser(DeterministicParserAdapter()).parse(recipe).tasks)


def test_chicken_biscuit_freezing_is_advance_and_final_baking_stays_main():
    recipe = get_recipe_payload('5c8646fe98d5bc7e184a90bc')
    tasks = list(RecipeParser(DeterministicParserAdapter()).parse(recipe).tasks)
    result = classify_preparation_phases(tasks)
    assert len(result['holds']) == 1
    assert result['holds'][0]['duration_sec'] == 24 * 3600
    assert any(item['task_id'].endswith('_prep') for item in tasks if item['task_id'] in result['advance_task_ids'])
    assert tasks[0]['task_id'] in result['advance_task_ids']
    assert tasks[-1]['task_id'] in result['main_task_ids']
    assert result['review_required'] == []
    assert set(result['advance_task_ids'] + result['main_task_ids']) == {task['task_id'] for task in tasks}
    # Merely labelling advance work cannot mark it completed or change its true duration.
    assert all('phase' not in task and 'status' not in task for task in tasks)


def test_short_refrigeration_remains_in_main_flow():
    tasks = parse_steps('r1', ['将面团揉匀，再放入冰箱冷藏30分钟。', '取出面团搓圆。'])
    result = classify_preparation_phases(tasks)
    assert not result['advance_task_ids']
    assert result['main_task_ids'] == [task['task_id'] for task in tasks]


def test_three_hour_explicit_refrigeration_is_advance():
    tasks = parse_steps('r3h', ['将肉切块后，放入冰箱冷藏3小时。', '取出煎10分钟。'])
    result = classify_preparation_phases(tasks)
    assert result['advance_task_ids']
    assert result['holds'][0]['duration_sec'] == 3 * 3600
    assert result['main_task_ids']


def test_two_hour_chilling_is_advance_when_far_longer_than_remaining_cooking():
    tasks = parse_steps('r2h', ['将肉切块后，放入冰箱冷藏2小时。', '取出煎10分钟。'])
    result = classify_preparation_phases(tasks)
    assert result['advance_task_ids']
    assert result['holds'][0]['duration_sec'] == 2 * 3600


def test_two_hour_unchilled_marinade_needs_storage_review():
    tasks = parse_steps('r2hunknown', ['将肉腌制2小时。', '放入锅内炒10分钟。'])
    result = classify_preparation_phases(tasks)
    assert not result['advance_task_ids']
    assert result['review_required']


def test_vague_long_marinating_needs_confirmed_time_not_fake_three_hours():
    tasks = parse_steps('rvague', ['将肉加入调味料长时间腌制。', '放入锅内炒10分钟。'])
    assert tasks[0]['field_status']['duration_sec'] == 'defaulted'
    result = classify_preparation_phases(tasks)
    assert not result['advance_task_ids']
    assert result['review_required']
    assert '确认' in result['review_required'][0]['reason']
    assert result['main_task_ids'] == [task['task_id'] for task in tasks]


def test_short_marinating_without_advance_phrase_does_not_require_review():
    tasks = parse_steps('rshort', ['将肉腌制10分钟。', '放入锅内炒10分钟。'])
    result = classify_preparation_phases(tasks)
    assert not result['advance_task_ids']
    assert not result['review_required']


def test_long_stove_cooking_not_called_advance():
    tasks = parse_steps('r2', ['把排骨放入锅中炖煮5小时。', '切葱花装盘。'])
    result = classify_preparation_phases(tasks)
    assert not result['advance_task_ids']
    assert not result['holds']


def test_overnight_soak_without_atomic_boundaries_requires_review():
    recipe = get_recipe_payload('65f7f4ee85eb6c79dfb992ff')
    tasks = list(RecipeParser(DeterministicParserAdapter()).parse(recipe).tasks)
    result = classify_preparation_phases(tasks)
    assert not result['advance_task_ids']
    assert result['review_required']
    assert result['review_required'][0]['task_id'] == tasks[0]['task_id']


def test_long_marinade_without_explicit_chilling_is_not_assumed_safe():
    tasks = parse_steps('r3', ['将肉拌匀后腌制12小时。', '放入锅内炒10分钟。'])
    result = classify_preparation_phases(tasks)
    assert not result['advance_task_ids']
    assert result['review_required']


def test_hot_cook_before_freezing_is_not_silently_moved_to_previous_day():
    tasks = parse_steps('r4', ['放锅中煮沸10分钟。', '将材料装入容器，放冰箱冷冻8小时。', '取出摆盘。'])
    result = classify_preparation_phases(tasks)
    assert not result['advance_task_ids']
    assert result['review_required']


def test_untrusted_dependency_graph_not_relabelled():
    tasks = parse_steps('r5', ['将肉切片，放入冰箱冷藏8小时。', '撒调味料。'])
    tasks[1]['predecessors'] = []
    result = classify_preparation_phases(tasks)
    assert not result['advance_task_ids']
    assert result['review_required']


def test_unsplit_cooking_and_long_refrigeration_needs_review():
    # The device detector sees the fridge noun, but this one task also contains
    # an earlier hot cooking action: never relocate the complete task blindly.
    tasks = parse_steps('r6', ['将食材煮沸10分钟后放入冰箱冷藏5小时。', '取出装盘。'])
    result = classify_preparation_phases(tasks)
    assert not result['advance_task_ids']
    assert result['review_required']


def test_official_100_classification_keeps_every_task_and_never_mutates():
    parser = RecipeParser(DeterministicParserAdapter())
    recipes = _load_recipes()
    assert len(recipes) == 100
    for recipe in recipes:
        tasks = list(parser.parse({**recipe, "schema_version": "1.0"}).tasks)
        before = [task.copy() for task in tasks]
        result = classify_preparation_phases(tasks)
        all_ids = [task["task_id"] for task in tasks]
        assert result["advance_task_ids"] + result["main_task_ids"] == all_ids
        assert len(all_ids) == len(set(all_ids))
        assert {entry["task_id"] for entry in result["holds"]} <= set(result["advance_task_ids"])
        assert {entry["task_id"] for entry in result["review_required"]} <= set(all_ids)
        assert tasks == before  # Does not modify actual schema-valid scheduling input.
