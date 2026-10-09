import { describe, expect, it } from 'vitest'
import { suggestedStartTime } from './planningTime'

describe('suggestedStartTime', () => {
  it('subtracts the actual schedule duration from the requested finish time', () => {
    expect(suggestedStartTime('12:30', 90 * 60)).toEqual({ time: '11:00', daysBefore: 0 })
  })
  it('rounds seconds up so the target is not missed', () => {
    expect(suggestedStartTime('12:30', 90 * 60 + 1)).toEqual({ time: '10:59', daysBefore: 0 })
  })
  it('marks a suggestion on the previous day', () => {
    expect(suggestedStartTime('00:30', 90 * 60)).toEqual({ time: '23:00', daysBefore: 1 })
  })
  it('reports the number of days for plans spanning multiple days', () => {
    expect(suggestedStartTime('12:30', 37 * 3600)).toEqual({ time: '23:30', daysBefore: 2 })
  })
  it('does not invent a time for invalid input', () => {
    expect(suggestedStartTime('27:00', 60)).toBeNull()
    expect(suggestedStartTime('12:30', Number.NaN)).toBeNull()
  })
})
