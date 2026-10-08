import { describe, expect, it } from 'vitest'
import { draftToKitchen } from './agent'
import type { AgentPlanDraft } from '../types/product'

const completeDraft: AgentPlanDraft = {
  recipes: [
    { recipe_id: 'r1', name: '菜1' },
    { recipe_id: 'r2', name: '菜2' },
    { recipe_id: 'r3', name: '菜3' },
  ],
  target_time: '18:30',
  operator_count: 1,
  devices: {
    stove_count: 1,
    steamer_count: 0,
    oven_count: 1,
    refrigerator_count: 1,
    dishwasher_count: 0,
    range_hood_count: 1,
    water_purifier_count: 1,
  },
}

describe('Agent kitchen conversion', () => {
  it('copies all seven device counts without fallback defaults', () => {
    expect(draftToKitchen(completeDraft)).toEqual({
      target_time: '18:30',
      operator_count: 1,
      stove_count: 1,
      steamer_count: 0,
      oven_count: 1,
      refrigerator_count: 1,
      dishwasher_count: 0,
      range_hood_count: 1,
      water_purifier_count: 1,
    })
  })

  it('rejects an incomplete device draft instead of inventing a default', () => {
    const incomplete: AgentPlanDraft = {
      ...completeDraft,
      devices: { ...completeDraft.devices },
    }
    delete incomplete.devices.water_purifier_count
    expect(() => draftToKitchen(incomplete)).toThrow('Agent 厨房设备信息尚未完整')
  })
})
