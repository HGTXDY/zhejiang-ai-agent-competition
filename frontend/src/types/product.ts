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
