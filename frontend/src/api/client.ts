import { addDish, getSchedule, postEvent } from '../mock/api'
import type { DashboardSchedule, DashboardTask, Notification, ScheduleResponse, TimelineResource } from '../types/contracts'

export interface CookFlowApi {
  getSchedule(): Promise<DashboardSchedule>
  postEvent(task: DashboardTask, status: DashboardTask['status']): Promise<{ task: DashboardTask; notification: Notification }>
  addDish(): Promise<{ tasks: DashboardTask[]; notification: Notification }>
}

const RESOURCE_LABELS: Record<string, string> = {
  operator_1: '操作员 · 主厨',
  stove_burner_1: '灶具 · 01',
  stove_burner_2: '灶具 · 02',
  steamer_1: '蒸箱 · 01',
  oven_1: '烤箱 · 01',
  refrigerator_1: '冰箱 · 01',
  dishwasher_1: '洗碗机 · 01',
  range_hood_1: '烟机 · 01',
  water_purifier_1: '净水机 · 01',
}
const RESOURCE_TONES: TimelineResource['tone'][] = ['gold', 'cyan', 'violet', 'slate']

function toDashboardSchedule(response: ScheduleResponse): DashboardSchedule {
  const resourceIds = [...new Set(response.tasks.flatMap(task => task.assigned_resources))]
  return {
    ...response,
    resources: resourceIds.map((id, index) => ({
      id,
      label: RESOURCE_LABELS[id] ?? id,
      tone: RESOURCE_TONES[index % RESOURCE_TONES.length],
    })),
    tasks: response.tasks.map(task => ({ ...task, action: task.task_id })),
  }
}

export class HttpCookFlowApi implements CookFlowApi {
  constructor(private readonly baseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000') {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body?.error?.message ?? `API request failed: ${response.status}`)
    return body as T
  }

  async getSchedule(): Promise<DashboardSchedule> {
    await this.request<{ status: string }>('/health')
    const request = await fetch('/demo/schedule-request.json').then(response => {
      if (!response.ok) throw new Error('Demo schedule request is unavailable')
      return response.json()
    })
    return toDashboardSchedule(await this.request<ScheduleResponse>('/v1/schedules', { method: 'POST', body: JSON.stringify(request) }))
  }

  // Execution-event and replan endpoints are not part of the current API PR yet.
  // Keep these operations on the explicit mock seam until that contract is merged.
  postEvent = postEvent
  addDish = addDish
}

const mode = import.meta.env.VITE_API_MODE ?? 'mock'
export const api: CookFlowApi = mode === 'http' ? new HttpCookFlowApi() : { getSchedule, postEvent, addDish }
export const apiMode = mode === 'http' ? 'HTTP API' : 'MOCK API'
