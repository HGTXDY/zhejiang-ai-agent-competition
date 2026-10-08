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
      dish_name: '测试菜',
    },
  ],
  validation: { valid: true, errors: [] },
  timings_ms: { parse: 0, validation: 0, solve: 0, notification: 0, total: 0 },
  notifications: [],
  resources: [{ id: 'stove_1', label: '灶具 · 01', tone: 'gold' }],
  target_time: '12:30',
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
    expect(currentSchedule).not.toHaveProperty('target_time')
  })

  it('strips the UI-only action and dish name fields from every task', () => {
    const envelope = toReplanEnvelope(event, scheduleRequest, current)
    const currentSchedule = envelope.current_schedule as { tasks: Array<Record<string, unknown>> }
    expect(currentSchedule.tasks[0]).not.toHaveProperty('action')
    expect(currentSchedule.tasks[0]).not.toHaveProperty('dish_name')
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

// HTTP mode regression: each accepted event advances the stateless request
// lineage; rejected events must never advance it.
describe('HttpCookFlowApi continuous Level 4 event lineage', () => {
  const makeRequest = (): ScheduleRequest => ({
    schema_version: '1.0', request_id: 'req-1',
    tasks: [{ task_id: 't1', dish_id: 'd1', action: '既有步骤', predecessors: [] }],
    device_config: { devices: [
      { device_id: 'stove_1', available: true },
      { device_id: 'stove_2', available: true },
    ] },
  })
  const testRecipe = { recipe_id: 'new_dish', name: '临时菜' } as import('../types/product').RecipeSummary
  const parsedTasks = [
    { task_id: 'prepare', dish_id: 'new_dish', action: '备料', predecessors: [] },
    { task_id: 'cook', dish_id: 'new_dish', action: '烹制', predecessors: ['prepare'] },
  ]

  async function setup() {
    const { HttpCookFlowApi } = await import('./client')
    const { vi } = await import('vitest')
    const requests: Array<Record<string, unknown>> = []
    let failed = false
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/recipes/new_dish')) return { ok: true, json: async () => ({ recipe_id: 'new_dish', name: '临时菜' }) }
      if (url.endsWith('/recipes/parse')) return { ok: true, json: async () => ({ recipe_id: 'new_dish', tasks: parsedTasks }) }
      if (!url.endsWith('/v1/replans')) throw new Error('unexpected URL: ' + url)
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      requests.push(body)
      if (failed) return { ok: false, status: 409, json: async () => ({ error: { code: 'SCHEDULE_INFEASIBLE', message: '无解' } }) }
      const previous = body.current_schedule as typeof current
      const event = body.event as ReplanEvent
      const newTasks = (event.event_type === 'DISH_ADDED' ? event.payload.tasks : []) as Array<{ task_id: string; dish_id: string }>
      const existing = previous.tasks.map(task => event.event_type === 'DEVICE_UNAVAILABLE'
        && !task.locked && task.assigned_resources.includes(event.payload.device_id as string)
        ? { ...task, assigned_resources: ['stove_2'] } : task)
      const combined = [...existing, ...newTasks.map(task => ({
        task_id: task.task_id, dish_id: task.dish_id, start_offset_sec: 300, end_offset_sec: 360,
        assigned_resources: ['stove_2'], status: 'PENDING' as const, locked: false, notification_points: [],
      }))]
      const schedule = { ...previous, schedule_id: `sched-${requests.length + 1}`, tasks: combined }
      return { ok: true, json: async () => ({
        schema_version: '1.0', event_id: event.event_id, previous_schedule_id: previous.schedule_id,
        schedule, changes: newTasks.map(task => ({ task_id: task.task_id, change_type: 'ADDED', new_start_offset_sec: 300, new_resources: ['stove_2'] })),
        disruption_metrics: { start_offset_total_sec: 0, resource_change_count: 0, order_change_count: 0, notified_task_change_count: 0 },
        disruption_score: 0,
      }) }
    })
    vi.stubGlobal('fetch', fetcher)
    const api = new HttpCookFlowApi('http://api')
    api.setScheduleRequest(makeRequest())
    return { api, requests, setFailed: (value: boolean) => { failed = value }, fetcher }
  }

  it('keeps newly added tasks and predecessor remapping in the second and third event', async () => {
    const { vi } = await import('vitest')
    const { api, requests } = await setup()
    try {
      const added = await api.addDish(current, testRecipe)
      const first = requests[0].event as ReplanEvent
      const newTasks = first.payload.tasks as Array<{ task_id: string; predecessors: string[] }>
      expect(new Set(newTasks.map(task => task.task_id)).size).toBe(2)
      expect(newTasks[1].predecessors).toEqual([newTasks[0].task_id])
      expect(added.schedule.tasks).toHaveLength(3)
      const running = { ...added.schedule, tasks: added.schedule.tasks.map(task => task.task_id === 't1' ? { ...task, status: 'RUNNING' as const } : task) }
      const delayed = await api.postEvent(running.tasks[0], 'DELAYED', running, { delaySec: 60 })
      const secondRequest = requests[1].schedule_request as { tasks: Array<{ task_id: string }> }
      expect(secondRequest.tasks.map(task => task.task_id)).toEqual(expect.arrayContaining(newTasks.map(task => task.task_id)))
      expect(delayed.schedule.tasks).toHaveLength(3)
      const third = await api.addDish(delayed.schedule, testRecipe)
      expect((requests[2].schedule_request as { tasks: unknown[] }).tasks).toHaveLength(3)
      expect(third.schedule.tasks).toHaveLength(5)
      expect(new Set(third.schedule.tasks.map(task => task.task_id)).size).toBe(5)
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps device failure unavailable through dish insertion and later delay', async () => {
    const { vi } = await import('vitest')
    const { api, requests } = await setup()
    try {
      const failure = await api.postEvent(current.tasks[0], 'EXCEPTION', current, { deviceId: 'stove_1' })
      const afterDish = await api.addDish(failure.schedule, testRecipe)
      const request2 = requests[1].schedule_request as { device_config: { devices: Array<{ device_id: string; available: boolean }> } }
      expect(request2.device_config.devices.find(device => device.device_id === 'stove_1')?.available).toBe(false)
      const running = { ...afterDish.schedule, tasks: afterDish.schedule.tasks.map(task => task.task_id === 't1' ? { ...task, status: 'RUNNING' as const } : task) }
      await api.postEvent(running.tasks[0], 'DELAYED', running)
      const request3 = requests[2].schedule_request as typeof request2
      expect(request3.device_config.devices.find(device => device.device_id === 'stove_1')?.available).toBe(false)
      expect((requests[2].schedule_request as { tasks: unknown[] }).tasks).toHaveLength(3)
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps request lineage and schedule unchanged after rejected replan', async () => {
    const { vi } = await import('vitest')
    const { api, requests, setFailed } = await setup()
    try {
      const added = await api.addDish(current, testRecipe)
      setFailed(true)
      const snapshot = structuredClone(added.schedule)
      await expect(api.postEvent({ ...added.schedule.tasks[0], status: 'RUNNING' }, 'DELAYED', added.schedule)).rejects.toThrow('无解')
      expect(added.schedule).toEqual(snapshot)
      setFailed(false)
      const after = await api.postEvent({ ...added.schedule.tasks[0], status: 'RUNNING' }, 'DELAYED', added.schedule)
      expect(after.schedule.tasks).toHaveLength(3)
      expect(requests[1].schedule_request).toEqual(requests[2].schedule_request)
      expect((requests[2].schedule_request as { tasks: unknown[] }).tasks).toHaveLength(3)
    } finally { vi.unstubAllGlobals() }
  })
})
