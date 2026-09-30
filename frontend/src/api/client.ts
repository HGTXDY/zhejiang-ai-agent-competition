import { addDish as mockAddDish, getSchedule as mockGetSchedule, postEvent as mockPostEvent } from '../mock/api'
import type { DashboardSchedule, DashboardTask, DiffType, Notification, ReplanEvent, ReplanEventType, ReplanResponse, ReplanResult, ScheduleRequest, ScheduleResponse, TimelineResource } from '../types/contracts'

export interface CookFlowApi {
  getSchedule(): Promise<DashboardSchedule>
  postEvent(task: DashboardTask, status: DashboardTask['status'], current: DashboardSchedule): Promise<ReplanResult>
  addDish(current: DashboardSchedule): Promise<ReplanResult>
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
      label: RESOURCE_LABELS[id] ?? id,
      tone: RESOURCE_TONES[index % RESOURCE_TONES.length],
    })),
    tasks: response.tasks.map(task => ({ ...task, action: (task as ScheduleTaskWithAction).action ?? task.task_id })),
  }
}
interface ScheduleTaskWithAction { action?: string }
const toDiffs = (response: ReplanResponse): ReplanResult['changes'] => response.changes.map(change => ({
  task_id: change.task_id,
  action: (response.schedule.tasks.find(task => task.task_id === change.task_id) as ScheduleTaskWithAction | undefined)?.action ?? change.task_id,
  type: (change.change_type === 'CANCELLED' ? 'REMOVED' : change.change_type) as DiffType,
  detail: change.change_type === 'MOVED' ? `时间调整至 ${formatOffset(change.new_start_offset_sec)}` : change.change_type === 'RESOURCE_CHANGED' ? `资源调整为 ${(change.new_resources ?? []).join('、') || '人工操作'}` : change.change_type === 'ADDED' ? '临时加入当前排程' : change.change_type === 'LOCKED' ? '已完成/执行中任务保持锁定' : '排程状态已更新',
}))
const formatOffset = (offset: number | null | undefined) => offset == null ? '—' : `${Math.floor(offset / 60)}:${String(offset % 60).padStart(2, '0')}`
const toResult = (response: ReplanResponse): ReplanResult => ({ schedule: apiSchedule(response.schedule), changes: toDiffs(response), notifications: response.schedule.notifications, disruptionScore: response.disruption_score })

export class HttpCookFlowApi implements CookFlowApi {
  private scheduleRequest: ScheduleRequest | null = null
  constructor(private readonly baseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000') {}
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body?.error?.message ?? `API request failed: ${response.status}`)
    return body as T
  }
  async getSchedule(): Promise<DashboardSchedule> {
    await this.request<{ status: string }>('/health')
    const request = await fetch('/demo/schedule-request.json').then(response => { if (!response.ok) throw new Error('Demo schedule request is unavailable'); return response.json() as Promise<ScheduleRequest> })
    this.scheduleRequest = request
    return apiSchedule(await this.request<ScheduleResponse>('/v1/schedules', { method: 'POST', body: JSON.stringify(request) }))
  }
  private async replan(event: ReplanEvent, current: DashboardSchedule, addedTasks?: Record<string, unknown>[]): Promise<ReplanResult> {
    if (!this.scheduleRequest) await this.getSchedule()
    const envelope = { event, schedule_request: this.scheduleRequest, current_schedule: { ...current, tasks: current.tasks.map(({ action: _action, ...task }) => task) } }
    if (addedTasks) event.payload = { ...event.payload, tasks: addedTasks }
    return toResult(await this.request<ReplanResponse>('/v1/replans', { method: 'POST', body: JSON.stringify(envelope) }))
  }
  async postEvent(task: DashboardTask, status: DashboardTask['status'], current: DashboardSchedule): Promise<ReplanResult> {
    const eventType: ReplanEventType = status === 'COMPLETED' ? 'TASK_COMPLETED' : status === 'DELAYED' ? 'TASK_DELAYED' : 'DEVICE_UNAVAILABLE'
    const payload = eventType === 'TASK_DELAYED' ? { task_id: task.task_id, delay_sec: 60 } : eventType === 'DEVICE_UNAVAILABLE' ? { device_id: task.assigned_resources.find(resource => resource !== 'operator_1') ?? task.assigned_resources[0] } : { task_id: task.task_id }
    return this.replan({ schema_version: '1.0', event_id: `evt_${Date.now()}`, schedule_id: current.schedule_id, event_type: eventType, occurred_at: new Date().toISOString(), payload }, current)
  }
  async addDish(current: DashboardSchedule): Promise<ReplanResult> {
    const task = { schema_version: '1.0', task_id: `added_dish_${Date.now()}`, dish_id: 'mapo_tofu', action: '麻婆豆腐烹制', resource_type: 'hybrid', duration_sec: 300, device_requirement: { device_type: 'stove', mode: 'stir_fry', capacity_units: 1 }, manual_segments: [{ offset_sec: 0, duration_sec: 30, action: '下锅' }], predecessors: [], interruptible: false, manual_required: true, manual_duration_sec: 30 }
    return this.replan({ schema_version: '1.0', event_id: `evt_${Date.now()}`, schedule_id: current.schedule_id, event_type: 'DISH_ADDED', occurred_at: new Date().toISOString(), payload: { tasks: [task] } }, current, [task])
  }
}

const mockApi: CookFlowApi = {
  getSchedule: mockGetSchedule,
  postEvent: async (task, status, current) => {
    const result = await mockPostEvent(task, status)
    return {
      schedule: { ...current, tasks: current.tasks.map(item => item.task_id === task.task_id ? result.task : item) },
      changes: [{ task_id: task.task_id, action: task.action, type: status === 'COMPLETED' ? 'LOCKED' : 'MOVED', detail: status === 'COMPLETED' ? '任务完成并锁定' : '事件已触发排程更新' }],
      notifications: [result.notification],
      disruptionScore: 0,
    }
  },
  addDish: async current => {
    const result = await mockAddDish()
    return {
      schedule: { ...current, tasks: [...current.tasks, ...result.tasks] },
      changes: result.tasks.map(task => ({ task_id: task.task_id, action: task.action, type: 'ADDED' as const, detail: '临时加菜加入排程' })),
      notifications: [result.notification],
      disruptionScore: 0,
    }
  },
}

export const api: CookFlowApi = import.meta.env.VITE_API_MODE === 'http' ? new HttpCookFlowApi() : mockApi
export const apiMode = import.meta.env.VITE_API_MODE === 'http' ? 'HTTP API' : 'MOCK API'
