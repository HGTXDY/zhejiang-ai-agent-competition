import type { DashboardSchedule } from './contracts'

export interface RecipeSummary {
  recipe_id: string
  name: string
  step_count: number
  preview: string
  tags: string[]
}

export interface KitchenConfig {
  target_time: string
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
  intent: 'create_schedule'
  reply: string
  draft: AgentPlanDraft
  missing_fields: string[]
  unmatched_recipe_names: string[]
  ready_to_confirm: boolean
  tool_trace: { name: string; status: 'completed' | 'waiting'; label: string }[]
}
export interface AgentCommandResponse {
  intent: 'add_dish' | 'device_unavailable' | 'task_delayed' | 'task_completed' | 'task_started' | 'unknown'
  reply: string
  ready: boolean
  recipe_id?: string | null
  task_id?: string | null
  device_id?: string | null
  delay_sec?: number
}
