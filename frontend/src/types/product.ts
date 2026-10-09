import type { DashboardSchedule, DeviceType } from './contracts'

export interface RecipeSummary {
  recipe_id: string
  name: string
  step_count: number
  preview: string
  tags: string[]
}

export interface KitchenConfig {
  /**
   * Local calendar day for the dinner deadline, `YYYY-MM-DD`.
   *
   * Optional so previously persisted sessions (and the Agent draft, which only
   * understands a wall-clock time) keep loading; `buildDeviceConfig` falls back
   * to today only when the value is absent, never when it is present but stale.
   */
  target_date?: string
  target_time: string
  /**
   * The instant `target_date` + `target_time` describe in the user's local
   * timezone, kept on the config so both the HTTP request builder and the Mock
   * scheduler derive the deadline from one value instead of two independent
   * clock conversions. Derived, never hand-edited.
   */
  target_ready_at?: string
  operator_count: number
  stove_count: number
  steamer_count: number
  oven_count: number
  refrigerator_count?: number
  dishwasher_count?: number
  range_hood_count?: number
  water_purifier_count?: number
}

export interface RecipeValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export interface ProductScheduleRequest {
  recipe_ids: string[]
  kitchen: KitchenConfig
}

export interface ProductScheduleResult {
  schedule: DashboardSchedule
  validation: RecipeValidation
}

export interface AgentRecipeMatch { recipe_id: string; name: string }
export interface AgentPlanDraft {
  recipes: AgentRecipeMatch[]
  target_time: string | null
  operator_count: number | null
  devices: Partial<Pick<KitchenConfig, 'stove_count' | 'steamer_count' | 'oven_count' | 'refrigerator_count' | 'dishwasher_count' | 'range_hood_count' | 'water_purifier_count'>>
}
export interface AgentPlanResponse {
  intent: 'create_schedule' | 'answer_question'
  reply: string
  draft: AgentPlanDraft
  missing_fields: string[]
  unmatched_recipe_names: string[]
  ready_to_confirm: boolean
  tool_trace: { name: string; status: 'completed' | 'waiting'; label: string }[]
}
export interface AgentCommandResponse {
  intent: 'add_dish' | 'device_unavailable' | 'task_delayed' | 'task_completed' | 'task_started' | 'add_device' | 'unknown'
  reply: string
  ready: boolean
  recipe_id?: string | null
  task_id?: string | null
  device_id?: string | null
  device_type?: DeviceType | null
  count?: number
  delay_sec?: number
}
