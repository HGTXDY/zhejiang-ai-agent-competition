import { initialSchedule } from './schedule'
import type { Notification, ScheduleResponse, ScheduleTask } from '../types/contracts'
const wait = (ms = 220) => new Promise(resolve => window.setTimeout(resolve, ms))
export async function getSchedule(): Promise<ScheduleResponse> { await wait(); return structuredClone(initialSchedule) }
export async function postEvent(task: ScheduleTask, status: ScheduleTask['status']): Promise<{ task: ScheduleTask; notification: Notification }> {
  await wait(); const labels: Partial<Record<ScheduleTask['status'], string>> = { COMPLETED: '完成', DELAYED: '延迟', EXCEPTION: '设备异常' }
  return { task: { ...task, status }, notification: { id: `${task.task_id}-${Date.now()}`, title: `${task.action} · 已上报${labels[status] ?? status}`, detail: status === 'EXCEPTION' ? '已标记待处理，排程等待重排' : 'Mock 事件已写入执行日志', level: status === 'EXCEPTION' ? 'danger' : status === 'DELAYED' ? 'warning' : 'success', created_at: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) } }
}
export async function addDish(): Promise<{ tasks: ScheduleTask[]; notification: Notification }> {
  await wait(); return { tasks: [
    { task_id: 'tofu_prepare', dish_id: 'mapo_tofu', action: '麻婆豆腐备料', start_offset_sec: 1260, end_offset_sec: 1380, assigned_resources: ['operator_1'], status: 'PENDING', locked: false },
    { task_id: 'tofu_stir', dish_id: 'mapo_tofu', action: '麻婆豆腐烹制', start_offset_sec: 1380, end_offset_sec: 1680, assigned_resources: ['stove_1', 'operator_1'], status: 'PENDING', locked: false },
  ], notification: { id: `dish-${Date.now()}`, title: '已加入临时菜：麻婆豆腐', detail: '等待调度器计算最小扰动方案', level: 'info', created_at: '刚刚' } }
}
