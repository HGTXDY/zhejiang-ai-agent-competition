import { describe, expect, it } from 'vitest'
import {
  describeDayDelta,
  formatLocalDateTime,
  instantToLocalInputs,
  localDayDelta,
  parseInstant,
  parseLocalDateTime,
  suggestedStart,
  targetDateTimeError,
  targetReadyAt,
  toDateInput,
  toTimeInput,
} from './planningTime'

/** Fixed reference "now" so these tests never depend on the wall clock. */
const NOW = new Date(2026, 9, 9, 9, 0, 0) // 2026-10-09 09:00 local

describe('parseLocalDateTime', () => {
  it('keeps the local calendar day instead of shifting through UTC', () => {
    const date = parseLocalDateTime('2026-10-11', '12:30')
    expect(date).not.toBeNull()
    // The regression this guards: `new Date('2026-10-11')` parses as UTC
    // midnight, which is 10-10 in any negative-offset timezone.
    expect(date!.getFullYear()).toBe(2026)
    expect(date!.getMonth()).toBe(9)
    expect(date!.getDate()).toBe(11)
    expect(date!.getHours()).toBe(12)
    expect(date!.getMinutes()).toBe(30)
  })

  it('round-trips through the date and time inputs', () => {
    const date = parseLocalDateTime('2026-10-11', '12:30')!
    expect(toDateInput(date)).toBe('2026-10-11')
    expect(toTimeInput(date)).toBe('12:30')
  })

  it('rejects malformed and impossible values', () => {
    expect(parseLocalDateTime('11/10/2026', '12:30')).toBeNull()
    expect(parseLocalDateTime('2026-10-11', '25:00')).toBeNull()
    expect(parseLocalDateTime('2026-13-01', '12:30')).toBeNull()
    // 2026-02-30 does not exist; the calendar would normalize it to March 2.
    expect(parseLocalDateTime('2026-02-30', '12:30')).toBeNull()
  })
})

describe('targetReadyAt', () => {
  it('builds a full ISO instant that round-trips to the chosen local time', () => {
    const iso = targetReadyAt('2026-10-11', '12:30', NOW)
    expect(iso).not.toBeNull()
    expect(iso).toMatch(/Z$|([+-]\d{2}:\d{2})$/)
    expect(instantToLocalInputs(iso)).toEqual({ date: '2026-10-11', time: '12:30' })
  })

  it('accepts today when the chosen time is still ahead', () => {
    expect(targetReadyAt('2026-10-09', '18:00', NOW)).not.toBeNull()
    expect(targetDateTimeError('2026-10-09', '18:00', NOW)).toBeNull()
  })

  it('accepts tomorrow at 12:30', () => {
    expect(targetDateTimeError('2026-10-10', '12:30', NOW)).toBeNull()
    expect(instantToLocalInputs(targetReadyAt('2026-10-10', '12:30', NOW)))
      .toEqual({ date: '2026-10-10', time: '12:30' })
  })

  it('accepts a day three days out', () => {
    expect(targetDateTimeError('2026-10-12', '12:30', NOW)).toBeNull()
    expect(instantToLocalInputs(targetReadyAt('2026-10-12', '12:30', NOW)))
      .toEqual({ date: '2026-10-12', time: '12:30' })
  })

  it('refuses a deadline that has already passed instead of rolling it forward', () => {
    expect(targetReadyAt('2026-10-08', '12:30', NOW)).toBeNull()
    expect(targetDateTimeError('2026-10-08', '12:30', NOW)).toContain('已经过去')
    // Same day, earlier clock time is also in the past.
    expect(targetReadyAt('2026-10-09', '08:00', NOW)).toBeNull()
    expect(targetDateTimeError('2026-10-09', '09:00', NOW)).toContain('已经过去')
  })

  it('reports a clear message for unparseable input', () => {
    expect(targetDateTimeError('', '', NOW)).toContain('有效的开饭日期和时间')
  })
})

describe('suggestedStart', () => {
  const target = targetReadyAt('2026-10-11', '12:30', NOW)!

  it('subtracts the real schedule duration from the chosen deadline', () => {
    const start = suggestedStart(target, 90 * 60)
    expect(start).not.toBeNull()
    expect(start!.time).toBe('11:00')
    expect(start!.daysBefore).toBe(0)
  })

  it('rounds seconds up so the target is not missed', () => {
    expect(suggestedStart(target, 90 * 60 + 1)!.time).toBe('10:59')
  })

  it('keeps the previous day when the plan crosses midnight', () => {
    const midnightish = targetReadyAt('2026-10-11', '00:30', NOW)!
    const start = suggestedStart(midnightish, 90 * 60)!
    expect(start.time).toBe('23:00')
    expect(start.daysBefore).toBe(1)
    expect(toDateInput(start.at)).toBe('2026-10-10')
  })

  it('carries the date across a 24-hour cold hold', () => {
    const start = suggestedStart(target, 24 * 3600)!
    expect(start.daysBefore).toBe(1)
    expect(toDateInput(start.at)).toBe('2026-10-10')
    expect(start.time).toBe('12:30')
  })

  it('does not invent a time for invalid input', () => {
    expect(suggestedStart(target, Number.NaN)).toBeNull()
    expect(suggestedStart(null, 60)).toBeNull()
    expect(suggestedStart('not-a-date', 60)).toBeNull()
  })

  it('uses the deadline instant rather than a bare clock string', () => {
    // The old helper only knew `HH:mm`, so it could not tell 10-11 from 10-12.
    const later = targetReadyAt('2026-10-12', '12:30', NOW)!
    expect(toDateInput(suggestedStart(target, 0)!.at)).toBe('2026-10-11')
    expect(toDateInput(suggestedStart(later, 0)!.at)).toBe('2026-10-12')
  })
})

describe('local calendar helpers', () => {
  it('counts whole local days without a UTC round-trip', () => {
    expect(localDayDelta(parseLocalDateTime('2026-10-09', '23:59')!, NOW)).toBe(0)
    expect(localDayDelta(parseLocalDateTime('2026-10-10', '00:01')!, NOW)).toBe(1)
    expect(localDayDelta(parseLocalDateTime('2026-10-12', '12:30')!, NOW)).toBe(3)
  })

  it('labels day offsets in words', () => {
    expect(describeDayDelta(0)).toBe('今天')
    expect(describeDayDelta(1)).toBe('明天')
    expect(describeDayDelta(2)).toBe('后天')
    expect(describeDayDelta(3)).toBe('3 天后')
    expect(describeDayDelta(-1)).toContain('已过去')
  })

  it('formats a full local deadline with its date', () => {
    expect(formatLocalDateTime(targetReadyAt('2026-10-11', '12:30', NOW))).toBe('10月11日 12:30')
    expect(formatLocalDateTime(null)).toBeNull()
    expect(formatLocalDateTime('garbage')).toBeNull()
  })

  it('returns null for an unusable instant', () => {
    expect(parseInstant('')).toBeNull()
    expect(parseInstant('nope')).toBeNull()
    expect(instantToLocalInputs(undefined)).toBeNull()
  })
})
