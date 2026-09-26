export type TaskStatus = 'PENDING' | 'RUNNING' | 'DELAYED' | 'COMPLETED' | 'EXCEPTION'
export type DiffType = 'ADDED' | 'REMOVED' | 'MOVED' | 'RESOURCE_CHANGED' | 'UNCHANGED' | 'LOCKED'

export interface ScheduleTask {
  task_id: string
  dish_id: string
  action: string
  start_offset_sec: number
  end_offset_sec: number
  assigned_resources: string[]
  status: TaskStatus
  locked: boolean
}
export interface ScheduleMetrics {
  makespan_sec: number
  finish_spread_sec: number
  max_continuous_manual_sec: number
  device_conflicts: number
  dependency_violations: number
}
export interface ScheduleResponse {
  schedule_id: string
  solver_status: 'OPTIMAL' | 'FEASIBLE'
  metrics: ScheduleMetrics
  tasks: ScheduleTask[]
}
export interface TimelineResource { id: string; label: string; tone: 'gold' | 'cyan' | 'violet' | 'slate' }
export interface ScheduleDiff { task_id: string; action: string; type: DiffType; detail: string }
export interface Notification { id: string; title: string; detail: string; level: 'info' | 'success' | 'warning' | 'danger'; created_at: string }
