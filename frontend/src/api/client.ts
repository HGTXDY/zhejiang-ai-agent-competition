import { ApiError } from '../lib/errors'
import { addDish as mockAddDish, getSchedule as mockGetSchedule, postEvent as mockPostEvent } from '../mock/api'
import type { DashboardSchedule, DashboardTask, DeviceType, DiffType, Notification, ReplanEvent, ReplanEventType, ReplanResponse, ReplanResult, ScheduleRequest, ScheduleResponse, TimelineResource } from '../types/contracts'
import type { RecipeSummary } from '../types/product'
import { makeDevice, resourceLabel, resourceTone } from './product'
import type { ParseResult, Recipe } from './product'

export interface CookFlowApi {
  setScheduleRequest(request: ScheduleRequest): void
  getSchedule(): Promise<DashboardSchedule>
  postEvent(task: DashboardTask, status: DashboardTask['status'], current: DashboardSchedule, options?: { delaySec?: number; deviceId?: string }): Promise<ReplanResult>
  addDish(current: DashboardSchedule, recipe: RecipeSummary): Promise<ReplanResult>
  addDevice(current: DashboardSchedule, deviceType: DeviceType, count?: number): Promise<ReplanResult>
}

const RESOURCE_LABELS: Record<string, string> = {
  operator_1: '操作员 · 主厨', stove_1: '灶具 · 01', steamer_1: '蒸箱 · 01', oven_1: '烤箱 · 01',
  refrigerator_1: '冰箱 · 01', dishwasher_1: '洗碗机 · 01', range_hood_1: '烟机 · 01', water_purifier_1: '净水机 · 01',
}
const RESOURCE_TONES: TimelineResource['tone'][] = ['gold', 'cyan', 'violet', 'slate']

const apiSchedule = (response: ScheduleResponse): DashboardSchedule => {
  const resourceIds = [...new Set(response.tasks.flatMap(task => task.assigned_resources))]
  return {
    ...response,
    resources: resourceIds.map((id, index) => ({
      id,
      label: resourceLabel(id),
      tone: resourceTone(id, index),
    })),
    tasks: response.tasks.map(task => ({ ...task, action: (task as ScheduleTaskWithAction).action ?? task.task_id, dish_name: (task as ScheduleTaskWithAction).dish_name })),
  }
}
interface ScheduleTaskWithAction { action?: string; dish_name?: string }
const toDiffs = (response: ReplanResponse): ReplanResult['changes'] => response.changes
  .filter(change => change.change_type !== 'UNCHANGED')
  .map(change => ({
    task_id: change.task_id,
    action: (response.schedule.tasks.find(task => task.task_id === change.task_id) as ScheduleTaskWithAction | undefined)?.action ?? change.task_id,
    type: (change.change_type === 'CANCELLED' ? 'REMOVED' : change.change_type) as DiffType,
    detail: change.change_type === 'MOVED' ? `时间调整至 ${formatOffset(change.new_start_offset_sec)}` : change.change_type === 'RESOURCE_CHANGED' ? `资源调整为 ${(change.new_resources ?? []).join('、') || '人工操作'}` : change.change_type === 'ADDED' ? '临时加入当前排程' : change.change_type === 'LOCKED' ? '已完成/执行中任务保持锁定' : '排程状态已更新',
  }))
const formatOffset = (offset: number | null | undefined) => offset == null ? '—' : `${Math.floor(offset / 60)}:${String(offset % 60).padStart(2, '0')}`
const toResult = (response: ReplanResponse, request: ScheduleRequest, dishName?: string): ReplanResult => {
  const tasks = (request.tasks ?? []) as Array<{ task_id: string; dish_id: string; action: string }>
  const labels = new Map(tasks.map(task => [task.task_id, task]))
  const schedule = apiSchedule(response.schedule)
  schedule.tasks = schedule.tasks.map(task => ({
    ...task,
    action: labels.get(task.task_id)?.action ?? task.action,
    dish_name: task.dish_name ?? (dishName && response.changes.some(change => change.task_id === task.task_id && change.change_type === 'ADDED') ? dishName : undefined),
  }))
  const changes = toDiffs(response).map(change => ({ ...change, action: labels.get(change.task_id)?.action ?? change.action }))
  return { schedule, changes, notifications: response.schedule.notifications, disruptionScore: response.disruption_score }
}

/** Build the V1 replan envelope, stripping UI-only fields from the schedule.
 *
 * `DashboardSchedule` adds top-level `resources`, `target_time` and
 * `target_ready_at` fields (and each task adds `action`/`dish_name` labels)
 * that are not part of `schedule-response.schema.json`, whose top level is
 * `additionalProperties: false`. The replan request must therefore send only
 * the standard V1 `ScheduleResponse` fields or the schema rejects it.
 */
export const toReplanEnvelope = (event: ReplanEvent, scheduleRequest: ScheduleRequest, current: DashboardSchedule): Record<string, unknown> => {
  const { resources: _resources, target_time: _targetTime, target_ready_at: _targetReadyAt, ...standardSchedule } = current
  return {
    event,
    schedule_request: scheduleRequest,
    current_schedule: {
      ...standardSchedule,
      tasks: current.tasks.map(({ action: _action, dish_name: _dishName, ...task }) => task),
    },
  }
}

const SCHEDULE_REQUEST_KEY = 'cookflow.schedule-request.v1'

/** The planner persists the accepted schedule (and `executionStarted`) so a page
 * reload restores the execution view, but the `HttpCookFlowApi` singleton is
 * rebuilt from scratch on reload. Replan requests (完成/延迟/设备异常/加菜/加设备)
 * need the original `ScheduleRequest` for lineage and the CP-SAT re-solve, so we
 * persist it alongside the session and restore it here. */
function loadPersistedScheduleRequest(): ScheduleRequest | null {
  try {
    const raw = localStorage.getItem(SCHEDULE_REQUEST_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Record<string, unknown>
    return value && typeof value === 'object' ? (value as ScheduleRequest) : null
  } catch {
    return null
  }
}
function persistScheduleRequest(request: ScheduleRequest): void {
  try { localStorage.setItem(SCHEDULE_REQUEST_KEY, JSON.stringify(request)) } catch { /* storage unavailable or quota exceeded */ }
}

export class HttpCookFlowApi implements CookFlowApi {
  private scheduleRequest: ScheduleRequest | null = null
  private acceptedScheduleId: string | null = null
  private replanInFlight = false
  private contextGeneration = 0
  private eventSequence = 0
  constructor(private readonly baseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000') {
    this.scheduleRequest = loadPersistedScheduleRequest()
  }
  setScheduleRequest(request: ScheduleRequest): void {
    this.scheduleRequest = structuredClone(request)
    this.acceptedScheduleId = null
    this.contextGeneration += 1
    persistScheduleRequest(request)
  }
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new ApiError(body?.error?.message ?? `API request failed: ${response.status}`, response.status, body?.error?.code)
    return body as T
  }
  async getSchedule(): Promise<DashboardSchedule> {
    await this.request<{ status: string }>('/health')
    const request = await fetch('/demo/schedule-request.json').then(response => { if (!response.ok) throw new Error('Demo schedule request is unavailable'); return response.json() as Promise<ScheduleRequest> })
    const result = await this.request<ScheduleResponse>('/v1/schedules', { method: 'POST', body: JSON.stringify(request) })
    this.setScheduleRequest(request)
    this.acceptedScheduleId = result.schedule_id
    return apiSchedule(result)
  }
  private async replan(event: ReplanEvent, current: DashboardSchedule, dishName?: string): Promise<ReplanResult> {
    if (!this.scheduleRequest) throw new Error('缺少初始排程请求，请重新生成排程')
    if (this.scheduleRequest.request_id !== current.request_id) throw new Error('排程请求上下文不匹配，请重新生成排程')
    if (this.acceptedScheduleId && this.acceptedScheduleId !== current.schedule_id) throw new Error('排程版本已变化，请使用最新排程')
    if (this.replanInFlight) throw new Error('上一次重排尚未完成，请勿重复提交')
    this.replanInFlight = true
    const generation = this.contextGeneration
    try {
      const envelope = toReplanEnvelope(event, this.scheduleRequest, current)
      const response = await this.request<ReplanResponse>('/v1/replans', { method: 'POST', body: JSON.stringify(envelope) })
      // Build the next lineage independently. Commit it only after the remote
      // solve and the complete response have both been accepted.
      if (generation !== this.contextGeneration) throw new Error('已生成新的初始排程，旧重排结果已丢弃')
      const nextRequest = structuredClone(this.scheduleRequest)
      if (event.event_type === 'DISH_ADDED') {
        const existing = new Set(((nextRequest.tasks ?? []) as Array<{ task_id: string }>).map(task => task.task_id))
        const added = event.payload.tasks as Array<{ task_id: string }>
        if (added.some(task => existing.has(task.task_id))) throw new Error('临时菜任务编号重复')
        nextRequest.tasks = [...((nextRequest.tasks ?? []) as object[]), ...structuredClone(added)]
      }
      if (event.event_type === 'DEVICE_UNAVAILABLE') {
        const config = nextRequest.device_config as { devices: Array<{ device_id: string; available?: boolean }> }
        const device = config.devices.find(item => item.device_id === event.payload.device_id)
        if (!device) throw new Error('故障设备不在排程请求中')
        device.available = false
      }
      if (event.event_type === 'DEVICE_ADDED') {
        const config = nextRequest.device_config as { devices: Array<{ device_id: string }> }
        const existing = new Set(config.devices.map(device => device.device_id))
        const added = event.payload.devices as Array<{ device_id: string }>
        if (added.some(device => existing.has(device.device_id))) throw new Error('新增设备编号重复')
        config.devices.push(...structuredClone(added))
      }
      const expectedIds = new Set(((nextRequest.tasks ?? []) as Array<{ task_id: string }>).map(task => task.task_id))
      const actualIds = response.schedule.tasks.map(task => task.task_id)
      const returnedTasks = new Map(response.schedule.tasks.map(task => [task.task_id, task]))
      const historyIntact = current.tasks.filter(task => task.locked || task.status === 'COMPLETED').every(task => {
        const after = returnedTasks.get(task.task_id)
        return after?.status === task.status && after?.locked === task.locked
          && after?.start_offset_sec === task.start_offset_sec && after?.end_offset_sec === task.end_offset_sec
          && JSON.stringify(after?.assigned_resources) === JSON.stringify(task.assigned_resources)
      })
      const unavailable = new Set(((nextRequest.device_config as { devices: Array<{ device_id: string; available?: boolean }> }).devices)
        .filter(device => device.available === false).map(device => device.device_id))
      const futureAvoidsFailures = response.schedule.tasks.every(task => task.locked
        || !task.assigned_resources.some(id => unavailable.has(id)))
      if (response.previous_schedule_id !== current.schedule_id
        || response.schedule.request_id !== current.request_id
        || response.schedule.schedule_id === current.schedule_id
        || response.schedule.validation.valid !== true
        || !['OPTIMAL', 'FEASIBLE'].includes(response.schedule.solver.status)
        || response.schedule.metrics.device_conflicts !== 0
        || response.schedule.metrics.dependency_violations !== 0
        || expectedIds.size !== actualIds.length
        || actualIds.some(id => !expectedIds.has(id))
        || !historyIntact || !futureAvoidsFailures) {
        throw new Error('重排响应不完整或校验未通过，已保留原排程')
      }
      const result = toResult(response, nextRequest, dishName)
      this.scheduleRequest = nextRequest
      this.acceptedScheduleId = response.schedule.schedule_id
      return result
    } finally {
      this.replanInFlight = false
    }
  }
  async postEvent(task: DashboardTask, status: DashboardTask['status'], current: DashboardSchedule, options?: { delaySec?: number; deviceId?: string }): Promise<ReplanResult> {
    if (status === 'RUNNING') {
      const notification: Notification = { notification_id: `evt-${Date.now()}`, level: 'info', type: 'schedule_updated', trigger_offset_sec: task.start_offset_sec, dish_id: task.dish_id, task_id: task.task_id, action: `${task.action} · 已开始执行`, parameters: { status }, message: '任务已进入执行中状态', created_at: new Date().toISOString() }
      const updatedTask = { ...task, status: 'RUNNING' as const }
      return { schedule: { ...current, tasks: current.tasks.map(item => item.task_id === task.task_id ? updatedTask : item) }, changes: [], notifications: [notification], disruptionScore: 0 }
    }
    const eventType: ReplanEventType = status === 'COMPLETED' ? 'TASK_COMPLETED' : status === 'DELAYED' ? 'TASK_DELAYED' : 'DEVICE_UNAVAILABLE'
    const payload = eventType === 'TASK_DELAYED' ? { task_id: task.task_id, delay_sec: options?.delaySec ?? 60 } : eventType === 'DEVICE_UNAVAILABLE' ? { device_id: options?.deviceId ?? task.assigned_resources.find(resource => !resource.startsWith('operator_')) ?? task.assigned_resources[0] } : { task_id: task.task_id }
    return this.replan({ schema_version: '1.0', event_id: `evt_${Date.now()}`, schedule_id: current.schedule_id, event_type: eventType, occurred_at: new Date().toISOString(), payload }, current)
  }
  async addDish(current: DashboardSchedule, recipe: RecipeSummary): Promise<ReplanResult> {
    const fullRecipe = await this.request<Recipe>(`/recipes/${encodeURIComponent(recipe.recipe_id)}`)
    const parsed = await this.request<ParseResult>('/recipes/parse', { method: 'POST', body: JSON.stringify(fullRecipe) })
    const stamp = `${Date.now()}_${++this.eventSequence}`
    if (new Set(parsed.tasks.map(task => task.task_id)).size !== parsed.tasks.length) throw new Error('临时菜解析结果存在重复任务')
    const parsedIds = new Set(parsed.tasks.map(task => task.task_id))
    if (parsed.tasks.some(task => task.predecessors.some(id => !parsedIds.has(id)))) throw new Error('临时菜解析结果存在无效依赖')
    const taskIdMap = new Map(parsed.tasks.map(task => [task.task_id, `${recipe.recipe_id}_${task.task_id}_${stamp}`]))
    const tasks = parsed.tasks.map(task => ({ ...task, task_id: taskIdMap.get(task.task_id)!, dish_id: recipe.recipe_id, predecessors: task.predecessors.map(id => taskIdMap.get(id) ?? id) }))
    if (!tasks.length) throw new Error('这道菜暂时无法解析出可执行步骤，请换一道菜')
    return this.replan({ schema_version: '1.0', event_id: `evt_${stamp}`, schedule_id: current.schedule_id, event_type: 'DISH_ADDED', occurred_at: new Date().toISOString(), payload: { tasks } }, current, recipe.name)
  }
  async addDevice(current: DashboardSchedule, deviceType: DeviceType, count = 1): Promise<ReplanResult> {
    if (!this.scheduleRequest) throw new Error('缺少初始排程请求，请重新生成排程')
    const config = this.scheduleRequest.device_config as { devices: Array<{ device_id: string; device_type: string }> }
    const suffix = config.devices
      .filter(device => device.device_type === deviceType)
      .reduce((max, device) => { const match = device.device_id.match(/(\d+)$/); return match ? Math.max(max, Number(match[1])) : max }, 0)
    const devices = Array.from({ length: Math.max(1, count) }, (_, i) => makeDevice(deviceType, suffix + 1 + i))
      .map(({ available: _available, ...device }) => device)
    const stamp = `${Date.now()}_${++this.eventSequence}`
    return this.replan({ schema_version: '1.0', event_id: `evt_${stamp}`, schedule_id: current.schedule_id, event_type: 'DEVICE_ADDED', occurred_at: new Date().toISOString(), payload: { devices } }, current)
  }
}

const mockApi: CookFlowApi = {
  setScheduleRequest: () => {},
  getSchedule: mockGetSchedule,
  postEvent: async (task, status, current) => {
    const result = await mockPostEvent(task, status)
    return {
      schedule: { ...current, tasks: current.tasks.map(item => item.task_id === task.task_id ? result.task : item) },
      changes: status === 'COMPLETED'
        ? [{ task_id: task.task_id, action: task.action, type: 'LOCKED' as const, detail: '任务完成并锁定' }]
        : status === 'DELAYED'
          ? [{ task_id: task.task_id, action: task.action, type: 'MOVED' as const, detail: '时间调整' }]
          : status === 'EXCEPTION'
            ? [{ task_id: task.task_id, action: task.action, type: 'RESOURCE_CHANGED' as const, detail: '设备异常，已重新安排' }]
            : [],
      notifications: [result.notification],
      disruptionScore: 0,
    }
  },
  addDish: async (current, recipe) => {
    const result = await mockAddDish(current, recipe)
    return {
      schedule: { ...current, tasks: [...current.tasks, ...result.tasks] },
      changes: result.tasks.map(task => ({ task_id: task.task_id, action: task.action, type: 'ADDED' as const, detail: '临时加菜加入排程' })),
      notifications: [result.notification],
      disruptionScore: 0,
    }
  },
  addDevice: async (current, deviceType, count = 1) => {
    const base = (RESOURCE_LABELS[`${deviceType}_1`] ?? deviceType).split(' · ')[0]
    const existing = current.resources.filter(resource => resource.id.startsWith(`${deviceType}_`))
    const suffix = existing.reduce((max, resource) => { const match = resource.id.match(/(\d+)$/); return match ? Math.max(max, Number(match[1])) : max }, 0)
    const added: TimelineResource[] = Array.from({ length: Math.max(1, count) }, (_, i) => {
      const index = suffix + 1 + i
      return { id: `${deviceType}_${index}`, label: `${base} · ${String(index).padStart(2, '0')}`, tone: RESOURCE_TONES[index % RESOURCE_TONES.length] }
    })
    const notification: Notification = {
      notification_id: `device-${Date.now()}`,
      type: 'schedule_updated',
      level: 'info',
      trigger_offset_sec: 0,
      dish_id: null,
      action: `已新增设备：${base}`,
      parameters: {},
      message: '演示模式已更新设备资源',
      created_at: new Date().toISOString(),
    }
    return { schedule: { ...current, resources: [...current.resources, ...added] }, changes: [], notifications: [notification], disruptionScore: 0 }
  },
}

export const api: CookFlowApi = import.meta.env.VITE_API_MODE === 'http' ? new HttpCookFlowApi() : mockApi
export const apiMode = import.meta.env.VITE_API_MODE === 'http' ? 'HTTP API' : 'MOCK API'
