import { initialSchedule } from './schedule'
import { recipeCatalog } from './recipes'
import type { DashboardSchedule, DashboardTask, TimelineResource } from '../types/contracts'
import type { KitchenConfig, ProductScheduleRequest, ProductScheduleResult, RecipeValidation } from '../types/product'

const wait = () => new Promise(resolve => setTimeout(resolve, 450))

export async function validateProductRequest(request: ProductScheduleRequest): Promise<RecipeValidation> {
  await wait()
  const errors: string[] = []
  const warnings: string[] = []
  if (request.recipe_ids.length < 3 || request.recipe_ids.length > 5) errors.push('请选择 3～5 道菜后再继续')
  if (request.kitchen.operator_count < 1) errors.push('至少需要配置 1 名操作员')
  if (request.kitchen.stove_count < 1 && request.kitchen.steamer_count < 1 && request.kitchen.oven_count < 1) errors.push('至少配置一种烹饪设备')
  const unknown = request.recipe_ids.filter(id => !recipeCatalog.some(recipe => recipe.recipe_id === id))
  if (unknown.length) errors.push('存在无法识别的菜谱，请重新选择')
  if (request.kitchen.target_time < '11:00' || request.kitchen.target_time > '22:00') warnings.push('目标开饭时间超出常规演示时段，请确认')
  return { valid: errors.length === 0, errors, warnings }
}

export async function createMockSchedule(request: ProductScheduleRequest): Promise<ProductScheduleResult> {
  const validation = await validateProductRequest(request)
  if (!validation.valid) return { schedule: initialSchedule, validation }
  const selected = request.recipe_ids.map(id => recipeCatalog.find(recipe => recipe.recipe_id === id)!).filter(Boolean)
  const resources: TimelineResource[] = [
    ...Array.from({ length: request.kitchen.operator_count }, (_, index) => ({ id: `operator_${index + 1}`, label: `操作员 · ${String(index + 1).padStart(2, '0')}`, tone: 'gold' as const })),
    ...Array.from({ length: request.kitchen.stove_count }, (_, index) => ({ id: `stove_${index + 1}`, label: `灶具 · ${String(index + 1).padStart(2, '0')}`, tone: 'cyan' as const })),
    ...Array.from({ length: request.kitchen.steamer_count }, (_, index) => ({ id: `steamer_${index + 1}`, label: `蒸箱 · ${String(index + 1).padStart(2, '0')}`, tone: 'violet' as const })),
    ...Array.from({ length: request.kitchen.oven_count }, (_, index) => ({ id: `oven_${index + 1}`, label: `烤箱 · ${String(index + 1).padStart(2, '0')}`, tone: 'slate' as const })),
  ]
  const cookingResources = resources.filter(resource => !resource.id.startsWith('operator_'))
  const tasks: DashboardTask[] = selected.flatMap((recipe, index) => {
    const base = index * 480
    const resource = cookingResources[index % cookingResources.length]
    return [
      { task_id: `${recipe.recipe_id}_prepare`, dish_id: recipe.recipe_id, dish_name: recipe.name, action: `${recipe.name}备料`, start_offset_sec: base, end_offset_sec: base + 150, assigned_resources: ['operator_1'], status: 'PENDING', locked: false, notification_points: [] },
      { task_id: `${recipe.recipe_id}_cook`, dish_id: recipe.recipe_id, dish_name: recipe.name, action: `${recipe.name}烹饪`, start_offset_sec: base + 150, end_offset_sec: base + 480, assigned_resources: [resource.id], status: 'PENDING', locked: false, notification_points: [] },
    ]
  })
  const schedule: DashboardSchedule = {
    ...initialSchedule,
    request_id: `cookflow_${Date.now()}`,
    schedule_id: `schedule_${Date.now()}`,
    solver: { ...initialSchedule.solver, duration_ms: 38, objective_value: tasks.length * 480 },
    metrics: { ...initialSchedule.metrics, makespan_sec: tasks.length ? Math.max(...tasks.map(task => task.end_offset_sec)) : 0, target_delay_sec: 0 },
    tasks,
    resources,
    target_time: request.kitchen.target_time,
    validation: { valid: true, errors: [] },
  }
  return { schedule, validation }
}
