import { describe, expect, it } from 'vitest'
import { toReplanEnvelope } from './client'
import type { DashboardSchedule, ReplanEvent, ScheduleRequest } from '../types/contracts'

const scheduleRequest: ScheduleRequest = { schema_version: '1.0', request_id: 'req-1', tasks: [], device_config: {} }

const current: DashboardSchedule = {
  schema_version: '1.0',
  request_id: 'req-1',
  schedule_id: 'sched-1',
  solver: { status: 'OPTIMAL', objective_value: 0, best_bound: 0, gap: 0, duration_ms: 1 },
  metrics: { makespan_sec: 0, finish_spread_sec: 0, max_continuous_manual_sec: 0, device_conflicts: 0, dependency_violations: 0, target_delay_sec: 0, serial_baseline_sec: 0, makespan_compression_ratio: 1 },
  tasks: [
    {
      task_id: 't1',
      dish_id: 'd1',
      start_offset_sec: 0,
      end_offset_sec: 60,
      assigned_resources: ['stove_1'],
      status: 'PENDING',
      locked: false,
      notification_points: [],
      action: '切菜',
    },
  ],
  validation: { valid: true, errors: [] },
  timings_ms: { parse: 0, validation: 0, solve: 0, notification: 0, total: 0 },
  notifications: [],
  resources: [{ id: 'stove_1', label: '灶具 · 01', tone: 'gold' }],
}

const event: ReplanEvent = {
  schema_version: '1.0',
  event_id: 'evt-1',
  schedule_id: 'sched-1',
  event_type: 'TASK_COMPLETED',
  occurred_at: '2026-09-27T12:00:00Z',
  payload: { task_id: 't1' },
}

const STANDARD_FIELDS = ['schema_version', 'request_id', 'schedule_id', 'solver', 'metrics', 'tasks', 'validation', 'timings_ms', 'notifications']

describe('toReplanEnvelope', () => {
  it('strips the UI-only top-level resources field from current_schedule', () => {
    const envelope = toReplanEnvelope(event, scheduleRequest, current)
    const currentSchedule = envelope.current_schedule as Record<string, unknown>
    expect(currentSchedule).not.toHaveProperty('resources')
  })

  it('strips the UI-only action field from every task', () => {
    const envelope = toReplanEnvelope(event, scheduleRequest, current)
    const currentSchedule = envelope.current_schedule as { tasks: Array<Record<string, unknown>> }
    expect(currentSchedule.tasks[0]).not.toHaveProperty('action')
  })

  it('keeps the standard V1 ScheduleResponse fields', () => {
    const envelope = toReplanEnvelope(event, scheduleRequest, current)
    const currentSchedule = envelope.current_schedule as Record<string, unknown>
    for (const field of STANDARD_FIELDS) {
      expect(currentSchedule).toHaveProperty(field)
    }
  })

  it('does not mutate the original schedule', () => {
    const snapshot = JSON.parse(JSON.stringify(current))
    toReplanEnvelope(event, scheduleRequest, current)
    expect(current).toEqual(snapshot)
  })
})

describe('real initial request context', () => {
  it('rejects missing or mismatched context instead of requesting Demo data', async () => {
    const { HttpCookFlowApi } = await import('./client')
    const { vi } = await import('vitest')
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    try {
      const api = new HttpCookFlowApi('http://api')
      await expect(api.postEvent({ ...current.tasks[0], status: 'RUNNING' }, 'DELAYED', current)).rejects.toThrow('缺少初始排程请求')
      api.setScheduleRequest({ ...scheduleRequest, request_id: 'other_request' })
      await expect(api.postEvent({ ...current.tasks[0], status: 'RUNNING' }, 'DELAYED', current)).rejects.toThrow('上下文不匹配')
      expect(fetcher).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })
})
