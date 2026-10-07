import { describe, expect, it } from 'vitest'
import { addDish } from './api'
import { initialSchedule } from './schedule'
import { recipeCatalog } from './recipes'

describe('mock execution replanning', () => {
  it('places a temporary dish after the current makespan instead of overlapping the Gantt plan', async () => {
    const currentEnd = Math.max(...initialSchedule.tasks.map(task => task.end_offset_sec))
    const recipe = recipeCatalog.find(item => item.name === '麻辣对虾')!
    const result = await addDish(initialSchedule, recipe)
    const [prepare, cook] = result.tasks

    expect(prepare.start_offset_sec).toBe(currentEnd)
    expect(prepare.end_offset_sec).toBe(cook.start_offset_sec)
    expect(cook.end_offset_sec).toBe(currentEnd + 420)
    expect(result.tasks.every(task => task.start_offset_sec >= currentEnd)).toBe(true)
  })
})
