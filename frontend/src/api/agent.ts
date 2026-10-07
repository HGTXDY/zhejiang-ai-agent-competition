import { productApi } from './product'
import type { AgentPlanDraft, AgentPlanResponse, RecipeSummary } from '../types/product'
import type { KitchenConfig } from '../types/product'

const chinese: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const numberOf = (value: string) => /^\d+$/.test(value) ? Number(value) : chinese[value]
const countOf = (text: string, noun: string) => {
  const match = text.match(new RegExp(`([一二两三四五六七八九十\\d]+)\\s*(?:个|台|名)?${noun}`))
  return match ? numberOf(match[1]) : undefined
}
const timeOf = (text: string) => {
  const digital = text.match(/(上午|早上|中午|下午|晚上|今晚)?\s*(\d{1,2})[:：](\d{2})/)
  if (digital) {
    let hour = Number(digital[2]); const minute = Number(digital[3])
    if (['下午', '晚上', '今晚'].includes(digital[1]) && hour < 12) hour += 12
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  }
  const spoken = text.match(/(上午|早上|中午|下午|晚上|今晚)?\s*([一二两三四五六七八九十\d]{1,2})点(半|[一二三四五六七八九十\d]{1,2}分?)?/)
  if (!spoken) return undefined
  let hour = numberOf(spoken[2]); const minute = spoken[3] === '半' ? 30 : numberOf((spoken[3] ?? '').replace('分', '')) || 0
  if (['下午', '晚上', '今晚'].includes(spoken[1]) && hour < 12) hour += 12
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function interpretAgentMessageMock(message: string, catalog: RecipeSummary[], context?: AgentPlanDraft): AgentPlanResponse {
  const matches = catalog.filter(recipe => message.includes(recipe.name)).slice(0, 5).map(({ recipe_id, name }) => ({ recipe_id, name }))
  const recipes = matches.length ? matches : context?.recipes ?? []
  const devices = { ...(context?.devices ?? {}) }
  const stove = countOf(message, '灶(?:眼)?'); const steamer = countOf(message, '蒸箱'); const oven = countOf(message, '烤箱')
  if (stove !== undefined) devices.stove_count = stove
  if (steamer !== undefined) devices.steamer_count = steamer
  if (oven !== undefined) devices.oven_count = oven
  const draft: AgentPlanDraft = { recipes, target_time: timeOf(message) ?? context?.target_time ?? null, operator_count: countOf(message, '人') ?? context?.operator_count ?? null, devices }
  const missing_fields = [recipes.length < 3 || recipes.length > 5 ? 'recipes' : '', !draft.target_time ? 'target_time' : '', !draft.operator_count ? 'operator_count' : '', ...(['stove_count', 'steamer_count', 'oven_count'] as const).filter(key => devices[key] === undefined)].filter(Boolean) as string[]
  const prompts: Record<string, string> = { recipes: '请告诉我想做的 3～5 道菜。', target_time: '希望几点开饭？', operator_count: '有几个人做饭？', stove_count: '有几个灶眼？', steamer_count: '有几台蒸箱？', oven_count: '有几台烤箱？' }
  return { intent: 'create_schedule', reply: missing_fields.length ? `我已经记下现有信息。${missing_fields.slice(0, 2).map(item => prompts[item]).join('')}` : `我理解了：${draft.target_time} 开饭，${draft.operator_count} 人操作，共 ${recipes.length} 道菜。请确认后生成计划。`, draft, missing_fields, unmatched_recipe_names: [], ready_to_confirm: !missing_fields.length, tool_trace: [{ name: 'match_recipes', status: 'completed', label: `已匹配 ${recipes.length} 道菜` }, { name: 'read_kitchen', status: missing_fields.some(item => item.endsWith('_count')) ? 'waiting' : 'completed', label: '已读取厨房条件' }, { name: 'validate_draft', status: missing_fields.length ? 'waiting' : 'completed', label: '已检查规划信息' }] }
}

export async function interpretAgentMessage(message: string, catalog: RecipeSummary[], context?: AgentPlanDraft) {
  return import.meta.env.VITE_API_MODE === 'http' ? productApi.interpretAgentMessage(message, context) : interpretAgentMessageMock(message, catalog, context)
}

export function draftToKitchen(draft: AgentPlanDraft, fallback: KitchenConfig): KitchenConfig {
  return { ...fallback, target_time: draft.target_time!, operator_count: draft.operator_count!, stove_count: draft.devices.stove_count!, steamer_count: draft.devices.steamer_count!, oven_count: draft.devices.oven_count! }
}
