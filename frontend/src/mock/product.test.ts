import { describe, expect, it } from 'vitest'
import { createMockSchedule } from './product'
import { recipeCatalog } from './recipes'

const kitchen = { target_time: '18:30', operator_count: 1, stove_count: 1, steamer_count: 1, oven_count: 1 }

describe('demo scheduler parallelism', () => {
  it('overlaps cooking on different devices with preparation of later dishes', async () => {
    const result = await createMockSchedule({ recipe_ids: recipeCatalog.slice(0, 3).map(recipe => recipe.recipe_id), kitchen })
    const tasks = result.schedule.tasks
    const firstCook = tasks.find(task => task.task_id === `${recipeCatalog[0].recipe_id}_cook`)!
    const secondPrepare = tasks.find(task => task.task_id === `${recipeCatalog[1].recipe_id}_prepare`)!
    const secondCook = tasks.find(task => task.task_id === `${recipeCatalog[1].recipe_id}_cook`)!
    expect(secondPrepare.start_offset_sec).toBeLessThan(firstCook.end_offset_sec)
    expect(secondCook.start_offset_sec).toBeLessThan(firstCook.end_offset_sec)
    expect(result.schedule.metrics.makespan_sec).toBeLessThan(result.schedule.metrics.serial_baseline_sec)
  })

  it('does not overlap cooking tasks that share the only device', async () => {
    const result = await createMockSchedule({ recipe_ids: recipeCatalog.slice(0, 3).map(recipe => recipe.recipe_id), kitchen: { ...kitchen, steamer_count: 0, oven_count: 0 } })
    const cooks = result.schedule.tasks.filter(task => task.task_id.endsWith('_cook')).sort((a, b) => a.start_offset_sec - b.start_offset_sec)
    for (let index = 1; index < cooks.length; index += 1) expect(cooks[index].start_offset_sec).toBeGreaterThanOrEqual(cooks[index - 1].end_offset_sec)
  })
})
