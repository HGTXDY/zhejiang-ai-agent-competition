import { initialSchedule } from './schedule'
import type { DashboardSchedule, DashboardTask, Notification } from '../types/contracts'

const wait = (ms = 220) => new Promise(resolve => window.setTimeout(resolve, ms))

export async function getSchedule(): Promise<DashboardSchedule> {
  await wait()
  return structuredClone(initialSchedule)
}

export async function postEvent(
  task: DashboardTask,
  status: DashboardTask['status'],
): Promise<{ task: DashboardTask; notification: Notification }> {
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

export async function addDish(): Promise<{ tasks: DashboardTask[]; notification: Notification }> {
  await wait()
  return {
    tasks: [
      { task_id: 'tofu_prepare', dish_id: 'mapo_tofu', action: '麻婆豆腐备料', start_offset_sec: 1260, end_offset_sec: 1380, assigned_resources: ['operator_1'], status: 'PENDING', locked: false, notification_points: [] },
      { task_id: 'tofu_stir', dish_id: 'mapo_tofu', action: '麻婆豆腐烹制', start_offset_sec: 1380, end_offset_sec: 1680, assigned_resources: ['stove_1', 'operator_1'], status: 'PENDING', locked: false, notification_points: [] },
    ],
    notification: {
      notification_id: `dish-${Date.now()}`,
      type: 'schedule_updated',
      level: 'info',
      trigger_offset_sec: 0,
      dish_id: 'mapo_tofu',
      action: '已加入临时菜：麻婆豆腐',
      parameters: {},
      message: '等待调度器计算最小扰动方案',
      created_at: new Date().toISOString(),
    },
  }
}
