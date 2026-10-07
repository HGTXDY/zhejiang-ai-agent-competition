import { productApi } from './product'
import type { AgentPlanDraft, AgentPlanResponse, RecipeSummary } from '../types/product'
import type { KitchenConfig } from '../types/product'

export async function interpretAgentMessage(message: string, catalog: RecipeSummary[], context?: AgentPlanDraft) {
  void catalog
  if (import.meta.env.VITE_API_MODE !== 'http') throw new Error('请先使用 HTTP 模式并在右上角配置大模型')
  return productApi.interpretAgentMessage(message, context)
}

export function draftToKitchen(draft: AgentPlanDraft, fallback: KitchenConfig): KitchenConfig {
  return { ...fallback, target_time: draft.target_time!, operator_count: draft.operator_count!, stove_count: draft.devices.stove_count!, steamer_count: draft.devices.steamer_count!, oven_count: draft.devices.oven_count! }
}
