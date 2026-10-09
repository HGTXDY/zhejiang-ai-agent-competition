import profiles from './device-profiles.json'
import type { DashboardSchedule, DeviceType, ScheduleDevice, ScheduleRequest, ScheduleResponse, TimelineResource, ValidationError } from '../types/contracts'
import type { AgentCommandResponse, AgentPlanDraft, AgentPlanResponse, KitchenConfig, RecipeSummary } from '../types/product'
import { targetDateTimeError, targetReadyAt } from '../lib/planningTime'

export interface Recipe {
  schema_version: '1.0'; recipe_id: string; name: string; ingredients: string[]; steps_text: string[]; source?: string
}
export interface ParsedTask {
  schema_version: '1.0'; task_id: string; dish_id: string; action: string; duration_sec: number
  resource_type: 'manual' | 'device' | 'hybrid' | 'wait'
  predecessors: string[]; interruptible: boolean; manual_required: boolean; manual_duration_sec: number
  manual_segments: { offset_sec: number; duration_sec: number; action: string }[]
  device_requirement?: { device_type: string; mode?: string | null; temperature_c?: number | null; capacity_units: number }
  confidence?: number | null; field_status?: Record<string, string>
}
export type ParserProvider = 'deterministic' | 'llm'
export interface ModelSettings {
  parser_provider: ParserProvider; configured: boolean; ready: boolean; base_url: string | null; model: string
  api_key_masked: string | null; source: 'environment' | 'runtime'; notes: string[]
}
export interface ModelSettingsUpdate {
  parser_provider?: ParserProvider; base_url?: string | null; model?: string | null; api_key?: string | null; clear_api_key?: boolean
}
export interface ModelProbeResult { ok: boolean; model: string; base_url: string; message: string }
export interface ParseResult { schema_version: '1.0'; recipe_id: string; provider: string; tasks: ParsedTask[] }
export interface DeviceConfig {
  schema_version: '1.0'; operator_count: number; target_ready_at: string
  devices: { device_id: string; device_type: string; capacity_units: number; capabilities: { modes: string[]; temperature_min_c: number | null; temperature_max_c: number | null }; available: boolean }[]
}
export interface InitialRequest extends ScheduleRequest { schema_version: '1.0'; request_id: string; tasks: ParsedTask[]; device_config: DeviceConfig }
export interface StagedPlanResponse {
  schema_version: '1.0'
  request_id: string
  status: 'READY' | 'PREPARATION_REQUIRED' | 'NEEDS_REVIEW'
  can_start_main: boolean
  advance_task_ids: string[]
  pending_advance_task_ids: string[]
  review_required: { task_id: string; reason: string }[]
  advance_schedule: ScheduleResponse | null
  main_schedule: ScheduleResponse
  executable_main_request: InitialRequest | null
  timing: {
    target_ready_at: string | null
    suggested_advance_start_at: string | null
    advance_finish_by: string | null
    suggested_main_start_at: string | null
    advance_makespan_sec: number
    main_makespan_sec: number
    total_elapsed_sec: number
    advance_start_offset_sec: number
    main_start_offset_sec: number
    total_finish_offset_sec: number
  }
}
export class ProductApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details: ValidationError[] = []) { super(message) }
}

// Demo presets copied from the current Parser default_device_config, not from selected tasks.
// device-profiles.test.ts checks every Parser mode and the canonical bounds/capacity.
export function makeDevice(type: DeviceType, index: number): ScheduleDevice {
  const profile = profiles[type]
  return {
    device_id: `${type}_${index}`,
    device_type: type,
    capacity_units: profile.capacity_units,
    capabilities: { modes: [...profile.modes], temperature_min_c: profile.temperature_min_c, temperature_max_c: profile.temperature_max_c },
    available: true,
  }
}

/** Resolve the deadline instant from the kitchen config, or null when unusable. */
export function kitchenTargetReadyAt(kitchen: KitchenConfig, now = new Date()): string | null {
  if (kitchen.target_ready_at) return kitchen.target_ready_at
  if (kitchen.target_date === undefined) {
    const match = /^(\d{2}):(\d{2})$/.exec(kitchen.target_time)
    if (!match) return null
    return legacyTargetReadyAt(Number(match[1]), Number(match[2]), now)
  }
  return targetReadyAt(kitchen.target_date, kitchen.target_time, now)
}

export function buildDeviceConfig(kitchen: KitchenConfig, now = new Date()): DeviceConfig {
  if (!/^\d{2}:\d{2}$/.test(kitchen.target_time)) throw new Error('请填写有效的目标开饭时间')
  const [hour, minute] = kitchen.target_time.split(':').map(Number)
  if (hour > 23 || minute > 59) throw new Error('请填写有效的目标开饭时间')
  // The deadline is the user's explicit local date + time. We never infer the
  // day from the clock alone and never roll it forward silently: an explicit
  // choice that has already passed is an error the user must resolve.
  const targetDate = kitchen.target_date
  if (targetDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error('请填写有效的开饭日期')
  const targetIso = kitchenTargetReadyAt(kitchen, now)
  if (targetIso === null) {
    throw new Error(targetDateTimeError(targetDate ?? '', kitchen.target_time, now) ?? '请填写有效的开饭日期和时间')
  }
  if (!Number.isInteger(kitchen.operator_count) || kitchen.operator_count < 1 || kitchen.operator_count > 20) throw new Error('操作员数量应为 1～20 的整数')
  const devices = (Object.keys(profiles) as (keyof typeof profiles)[]).flatMap(type => {
    const count = kitchen[`${type}_count`] ?? 0
    if (!Number.isInteger(count) || count < 0 || count > (type === 'stove' ? 8 : 4)) throw new Error('设备数量超出范围或不是整数')
    return Array.from({ length: count }, (_, i) => makeDevice(type, i + 1))
  })
  return { schema_version: '1.0', operator_count: kitchen.operator_count, target_ready_at: targetIso, devices }
}

/**
 * Deadline for a caller that only supplied a wall-clock time (the Agent draft
 * and sessions saved before the date picker existed). Kept for backwards
 * compatibility: it picks today, or tomorrow when today's time has passed.
 */
function legacyTargetReadyAt(hour: number, minute: number, now: Date): string {
  const target = new Date(now)
  target.setHours(hour, minute, 0, 0)
  if (target <= now) target.setDate(target.getDate() + 1)
  return target.toISOString()
}
export function assertSelection(ids: string[]) {
  if (ids.length < 3 || ids.length > 5 || new Set(ids).size !== ids.length) throw new Error('请选择 3～5 道不同的菜')
}
const RESOURCE_TYPE_LABELS: Record<string, string> = {
  operator: '操作员', stove: '灶具', steamer: '蒸箱', oven: '烤箱',
  refrigerator: '冰箱', dishwasher: '洗碗机', range_hood: '烟机', water_purifier: '净水机',
}
const RESOURCE_TYPE_TONES: Record<string, TimelineResource['tone']> = { operator: 'gold', stove: 'cyan', steamer: 'violet', oven: 'slate' }
const TONE_FALLBACKS: TimelineResource['tone'][] = ['gold', 'cyan', 'violet', 'slate']

const resourceType = (id: string) => { const match = id.match(/^(.*)_\d+$/); return match?.[1] ?? id }
export function resourceLabel(id: string): string {
  const type = resourceType(id)
  const base = RESOURCE_TYPE_LABELS[type] ?? type
  const num = Number(id.match(/_(\d+)$/)?.[1])
  return Number.isFinite(num) ? `${base} · ${String(num).padStart(2, '0')}` : base
}
export function resourceTone(id: string, index: number): TimelineResource['tone'] {
  const type = resourceType(id)
  return RESOURCE_TYPE_TONES[type] ?? TONE_FALLBACKS[index % TONE_FALLBACKS.length]
}

export function toDashboard(response: ScheduleResponse, tasks: ParsedTask[]): DashboardSchedule {
  const actions = new Map(tasks.map(task => [task.task_id, task.action]))
  return { ...response, tasks: response.tasks.map(task => ({ ...task, action: actions.get(task.task_id) ?? task.task_id })),
    resources: [...new Set(response.tasks.flatMap(task => task.assigned_resources))].map((id, i) => ({ id, label: resourceLabel(id), tone: resourceTone(id, i) })) }
}
export class ProductApi {
  constructor(private readonly baseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000') {}
  private async request<T>(path: string, payload?: unknown, method?: 'POST' | 'PUT' | 'DELETE'): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 70000)
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        signal: controller.signal, ...(!method && payload === undefined ? {} : { method: method ?? 'POST', headers: { 'Content-Type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }),
      })
      const body = await response.json().catch(() => { throw new ProductApiError('后端返回了无效 JSON', response.status, 'INVALID_RESPONSE') })
      if (!response.ok) throw new ProductApiError(body.error?.message ?? body.detail ?? `请求失败（${response.status}）`, response.status, body.error?.code ?? 'HTTP_ERROR', body.error?.details ?? [])
      return body as T
    } finally { clearTimeout(timeout) }
  }
  interpretAgentMessage(message: string, context?: AgentPlanDraft) {
    return this.request<AgentPlanResponse>('/agent/plan', { message, context })
  }
  interpretAgentCommand(payload: { message: string; tasks: unknown[]; recipes: RecipeSummary[] }) {
    return this.request<AgentCommandResponse>('/agent/command', payload)
  }
  async listRecipes(): Promise<RecipeSummary[]> {
    const result = await this.request<{ recipes: { recipe_id: string; name: string; step_count: number; ingredient_count: number }[] }>('/recipes')
    return result.recipes.map(recipe => ({ ...recipe, preview: `${recipe.ingredient_count} 种食材`, tags: ['官方菜谱'] }))
  }
  getRecipe(id: string) { return this.request<Recipe>(`/recipes/${encodeURIComponent(id)}`) }
  parseRecipe(recipe: Recipe, provider: ParserProvider = 'deterministic') { return this.request<ParseResult>(provider === 'llm' ? '/recipes/parse?provider=llm' : '/recipes/parse', recipe) }
  async parseSelection(ids: string[], provider: ParserProvider = 'deterministic') {
    assertSelection(ids)
    return Promise.all(ids.map(async id => this.parseRecipe(await this.getRecipe(id), provider)))
  }
  getModelSettings() { return this.request<ModelSettings>('/settings/model') }
  updateModelSettings(payload: ModelSettingsUpdate) { return this.request<ModelSettings>('/settings/model', payload, 'PUT') }
  testModelSettings(payload: ModelSettingsUpdate) { return this.request<ModelProbeResult>('/settings/model/test', payload) }
  resetModelSettings() { return this.request<ModelSettings>('/settings/model', undefined, 'DELETE') }
  async validateKitchen(kitchen: KitchenConfig) {
    const config = buildDeviceConfig(kitchen)
    const report = await this.request<{ valid: boolean; errors: ValidationError[] }>('/devices/validate', config)
    if (!report.valid) throw new ProductApiError('厨房设备配置未通过校验', 422, 'VALIDATION_FAILED', report.errors)
    return config
  }
  private async makeInitialRequest(ids: string[], kitchen: KitchenConfig, parsed: ParseResult[]): Promise<InitialRequest> {
    assertSelection(ids)
    if (parsed.length !== ids.length || !ids.every(id => parsed.some(result => result.recipe_id === id && result.tasks.length > 0))) throw new Error('请重新解析选中的菜谱')
    const tasks = parsed.flatMap(result => result.tasks)
    if (tasks.some(task => Object.values(task.field_status ?? {}).includes('missing'))) throw new Error('解析存在缺失字段，请更换菜谱；当前版本尚不支持字段补录')
    return { schema_version: '1.0', request_id: `product_${crypto.randomUUID()}`, tasks, device_config: await this.validateKitchen(kitchen) }
  }
  async createSchedule(ids: string[], kitchen: KitchenConfig, parsed: ParseResult[]) {
    const request = await this.makeInitialRequest(ids, kitchen, parsed)
    const response = await this.request<ScheduleResponse>('/schedules', request)
    if (!response.validation.valid || !['OPTIMAL', 'FEASIBLE'].includes(response.solver.status)) throw new Error('后端排程未通过校验')
    return { request, schedule: toDashboard(response, request.tasks) }
  }
  async createStagedSchedule(ids: string[], kitchen: KitchenConfig, parsed: ParseResult[]) {
    const request = await this.makeInitialRequest(ids, kitchen, parsed)
    const plan = await this.confirmStagedSchedule(request, [])
    return { request, plan, schedule: toDashboard(plan.main_schedule, request.tasks) }
  }
  async confirmStagedSchedule(request: InitialRequest, confirmedIds: string[]): Promise<StagedPlanResponse> {
    const plan = await this.request<StagedPlanResponse>('/schedules/staged', {
      schedule_request: request, confirmed_advance_task_ids: confirmedIds,
    })
    const taskIds = new Set(request.tasks.map(task => task.task_id))
    const advance = new Set(plan.advance_task_ids)
    const mainIds = plan.main_schedule?.tasks?.map(task => task.task_id) ?? []
    const pending = new Set(plan.pending_advance_task_ids)
    const advanceTasks = plan.advance_schedule?.tasks ?? []
    const confirmed = new Set(confirmedIds)
    const timing = plan.timing
    if (plan.request_id !== request.request_id
      || !plan.main_schedule?.validation?.valid
      || !['OPTIMAL', 'FEASIBLE'].includes(plan.main_schedule?.solver?.status)
      || !timing || !Number.isFinite(timing.total_elapsed_sec)
      || timing.total_elapsed_sec !== timing.advance_makespan_sec + timing.main_makespan_sec
      || timing.main_makespan_sec !== plan.main_schedule.metrics.makespan_sec
      || (plan.advance_schedule ? timing.advance_makespan_sec !== plan.advance_schedule.metrics.makespan_sec : timing.advance_makespan_sec !== 0)
      || advance.size !== plan.advance_task_ids.length
      || (advance.size > 0 && !plan.advance_schedule?.validation?.valid)
      || (advance.size > 0 && !['OPTIMAL', 'FEASIBLE'].includes(plan.advance_schedule?.solver?.status ?? 'UNKNOWN'))
      || advanceTasks.length !== advance.size
      || advanceTasks.some(task => !advance.has(task.task_id))
      || mainIds.length + advance.size !== taskIds.size
      || mainIds.some(id => !taskIds.has(id) || advance.has(id))
      || [...advance].some(id => !taskIds.has(id))
      || [...pending].some(id => !advance.has(id))
      || (plan.can_start_main && [...advance].some(id => !confirmed.has(id)))
      || (plan.can_start_main !== Boolean(plan.executable_main_request))
      || (plan.can_start_main && (plan.pending_advance_task_ids.length > 0 || plan.review_required.length > 0))
      || (plan.can_start_main && plan.executable_main_request?.request_id !== plan.main_schedule.request_id)
    ) throw new Error('分阶段排程响应校验失败，请重新生成排程')
    return plan
  }
}
export const productApi = new ProductApi()
export const productErrorMessage = (error: unknown) => error instanceof ProductApiError
  ? `${error.code}：${error.message}${error.details.length ? '；' + error.details.map(detail => `${detail.path ?? ''} ${detail.message}`).join('；') : ''}`
  : error instanceof Error ? error.message : '请求失败，请检查后端连接后重试'
