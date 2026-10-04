import { describe, expect, it } from 'vitest'
import { compressionPercent, delayHint, deriveDashboardMetrics, estimatedFinish, formatClock, formatDuration } from './metrics'
import type { ScheduleMetrics } from '../types/contracts'

const metrics: ScheduleMetrics = {
  makespan_sec: 2460,
  finish_spread_sec: 180,
  max_continuous_manual_sec: 240,
  device_conflicts: 0,
  dependency_violations: 0,
  target_delay_sec: 80,
  serial_baseline_sec: 4380,
  makespan_compression_ratio: 0.56,
}

const tasks = [
  { task_id: 'a', end_offset_sec: 120, status: 'COMPLETED' },
  { task_id: 'b', end_offset_sec: 2460, status: 'PENDING' },
]

describe('formatClock', () => {
  it('formats minutes after midnight as HH:MM', () => {
    expect(formatClock(12 * 60 + 41)).toBe('12:41')
    expect(formatClock(0)).toBe('00:00')
  })
})

describe('estimatedFinish / delayHint', () => {
  it('derives the finish time from makespan, not a hard-coded value', () => {
    // 12:30 + 2460s (41m) = 13:11
    expect(estimatedFinish(2460)).toBe('13:11')
  })

  it('derives the delay hint from target_delay_sec', () => {
    expect(delayHint(80)).toBe('较目标晚 1′')
    expect(delayHint(0)).toBe('按目标准时完成')
  })
})

describe('compressionPercent', () => {
  it('reports the serial time saved by parallelising', () => {
    expect(compressionPercent(0.56)).toBe(44)
    expect(compressionPercent(1)).toBe(0)
    expect(compressionPercent(0)).toBe(100)
  })
})

describe('deriveDashboardMetrics', () => {
  it('derives every metric from the schedule and tasks', () => {
    const derived = deriveDashboardMetrics(metrics, tasks)
    expect(derived.progress).toBe(50)
    expect(derived.estimatedFinish).toBe('13:11')
    expect(derived.delayHint).toBe('较目标晚 1′')
    expect(derived.finishSpread).toBe('3′')
    expect(derived.compression).toBe('44%')
    expect(derived.conflicts).toBe('0 冲突')
  })
})

describe('formatDuration', () => {
  it('rounds seconds to whole minutes with a prime mark', () => {
    expect(formatDuration(180)).toBe('3′')
    expect(formatDuration(89)).toBe('1′')
  })
})
