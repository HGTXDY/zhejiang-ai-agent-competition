import { productApi } from './product'
import type { AgentPlanDraft, AgentPlanResponse, RecipeSummary } from '../types/product'
import type { KitchenConfig } from '../types/product'

export async function interpretAgentMessage(message: string, catalog: RecipeSummary[], context?: AgentPlanDraft) {
  void catalog
  if (import.meta.env.VITE_API_MODE !== 'http') throw new Error('请先使用 HTTP 模式并在右上角配置大模型')
  return productApi.interpretAgentMessage(message, context)
}

export function draftToKitchen(draft: AgentPlanDraft): KitchenConfig {
  const targetTime = draft.target_time
  const operatorCount = draft.operator_count
  if (!targetTime || operatorCount === null || !Number.isInteger(operatorCount) || operatorCount < 1) throw new Error('Agent 规划信息尚未完整')
  const requiredDevices = ['stove_count', 'steamer_count', 'oven_count', 'refrigerator_count', 'dishwasher_count', 'range_hood_count', 'water_purifier_count'] as const
  for (const field of requiredDevices) {
    const value = draft.devices[field]
    if (!Number.isInteger(value) || (value ?? -1) < 0) throw new Error('Agent 厨房设备信息尚未完整')
  }
  return {
    target_time: targetTime,
    operator_count: operatorCount,
    stove_count: draft.devices.stove_count!,
    steamer_count: draft.devices.steamer_count!,
    oven_count: draft.devices.oven_count!,
    refrigerator_count: draft.devices.refrigerator_count!,
    dishwasher_count: draft.devices.dishwasher_count!,
    range_hood_count: draft.devices.range_hood_count!,
    water_purifier_count: draft.devices.water_purifier_count!,
  }
}
