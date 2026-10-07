import { ApiError } from '../lib/errors'
import { initialSchedule } from './schedule'
import type { DashboardSchedule, DashboardTask, Notification } from '../types/contracts'
import type { RecipeSummary } from '../types/product'

const wait = (ms = 220) => new Promise(resolve => window.setTimeout(resolve, ms))

export type MockFault = 'none' | 'infeasible' | 'timeout' | 'network'

let mockFault: MockFault = 'none'

/** Select the failure the mock API simulates on the next event. The demo uses
 * this to exercise the 409 / 504 / network-failure paths a live backend would
 * surface, since the mock otherwise never rejects. */
export function setMockFault(fault: MockFault) { mockFault = fault }
export function getMockFault(): MockFault { return mockFault }

function throwFault() {
  switch (mockFault) {
    case 'infeasible': throw new ApiError('当前约束下无法生成可行排程', 409, 'NO_FEASIBLE_SCHEDULE')
    case 'timeout': throw new ApiError('求解器在时限内未收敛', 504, 'SOLVER_TIMEOUT')
    case 'network': throw new TypeError('Failed to fetch')
    case 'none': return
  }
}

export async function getSchedule(): Promise<DashboardSchedule> {
  await wait()
  return structuredClone(initialSchedule)
}

export async function postEvent(
  task: DashboardTask,
  status: DashboardTask['status'],
): Promise<{ task: DashboardTask; notification: Notification }> {
  throwFault()
  await wait()
  const labels: Partial<Record<DashboardTask['status'], string>> = {
    RUNNING: '开始执行',
    COMPLETED: '完成',
    DELAYED: '延迟',
    EXCEPTION: '设备异常',
  }
  const notification: Notification = {
    notification_id: `${task.task_id}-${Date.now()}`,
    type: status === 'EXCEPTION' ? 'device_conflict' : status === 'DELAYED' ? 'task_delayed' : 'schedule_updated',
    level: status === 'EXCEPTION' ? 'error' : status === 'DELAYED' ? 'warning' : 'info',
    trigger_offset_sec: task.start_offset_sec,
    dish_id: task.dish_id,
    task_id: task.task_id,
    action: `${task.action} · 已上报${labels[status] ?? status}`,
    parameters: { status },
    message: status === 'EXCEPTION' ? '已标记待处理，排程等待重排' : 'Mock 事件已写入执行日志',
    created_at: new Date().toISOString(),
  }
  return { task: { ...task, status }, notification }
}

export async function addDish(current: DashboardSchedule, recipe: RecipeSummary): Promise<{ tasks: DashboardTask[]; notification: Notification }> {
  throwFault()
  await wait()
  const stamp = Date.now()
  const dishId = recipe.recipe_id
  const dishName = recipe.name
  // The mock must preserve the same invariant as the live CP-SAT replan:
  // adding a dish cannot place operator/stove work on top of existing work.
  // Appending after the current makespan is deliberately conservative and
  // avoids pretending that the demo has solved a new resource conflict.
  const start = Math.max(0, ...current.tasks.map(task => task.end_offset_sec))
  return {
    tasks: [
      { task_id: `${dishId}_prepare_${stamp}`, dish_id: dishId, dish_name: dishName, action: `${dishName}备料`, start_offset_sec: start, end_offset_sec: start + 120, assigned_resources: ['operator_1'], status: 'PENDING', locked: false, notification_points: [] },
      { task_id: `${dishId}_cook_${stamp}`, dish_id: dishId, dish_name: dishName, action: `${dishName}烹制`, start_offset_sec: start + 120, end_offset_sec: start + 420, assigned_resources: ['stove_1', 'operator_1'], status: 'PENDING', locked: false, notification_points: [] },
    ],
    notification: {
      notification_id: `dish-${stamp}`, type: 'schedule_updated', level: 'info', trigger_offset_sec: 0, dish_id: dishId,
      action: `已加入临时菜：${dishName}`, parameters: {}, message: '等待调度器计算最小扰动方案', created_at: new Date().toISOString(),
    },
  }
}
