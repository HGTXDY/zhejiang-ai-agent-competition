/** TypeScript mirror of contracts/v1/schemas/*.json. Keep API-facing types here. */
export type SolverStatus = 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN'
export type TaskStatus = 'PENDING' | 'LOCKED' | 'RUNNING' | 'DELAYED' | 'COMPLETED' | 'EXCEPTION' | 'CANCELLED'
export type NotificationLevel = 'info' | 'warning' | 'error'
export type NotificationType = 'task_due' | 'task_delayed' | 'device_conflict' | 'schedule_updated' | 'infeasible'
export type DiffType = 'ADDED' | 'REMOVED' | 'MOVED' | 'RESOURCE_CHANGED' | 'UNCHANGED' | 'LOCKED'

export interface ScheduleTask {
  task_id: string
  dish_id: string
  start_offset_sec: number
  end_offset_sec: number
  assigned_resources: string[]
  status: TaskStatus
  locked: boolean
  notification_points: NotificationPoint[]
}
export interface DashboardTask extends ScheduleTask {
  /** UI-only labels populated by the adapter; never sent to the V1 API. */
  action: string
  dish_name?: string
}
export interface NotificationPoint { type: 'start' | 'prepare' | 'manual' | 'complete' | 'exception'; offset_sec: number; message: string }
export interface Solver { status: SolverStatus; objective_value: number | null; best_bound: number | null; gap: number | null; duration_ms: number }
export interface ScheduleMetrics { makespan_sec: number; finish_spread_sec: number; max_continuous_manual_sec: number; device_conflicts: number; dependency_violations: number; target_delay_sec: number; serial_baseline_sec: number; makespan_compression_ratio: number }
export interface ValidationError { code: string; message: string; path?: string | null }
export interface ScheduleResponse {
  schema_version: '1.0'
  request_id: string
  schedule_id: string
  solver: Solver
  metrics: ScheduleMetrics
  tasks: ScheduleTask[]
  validation: { valid: boolean; errors: ValidationError[] }
  timings_ms: { parse: number; validation: number; solve: number; notification: number; total: number }
  notifications: Notification[]
}
export type DashboardSchedule = Omit<ScheduleResponse, 'tasks'> & { tasks: DashboardTask[]; resources: TimelineResource[]; target_time?: string }
export interface Notification {
  notification_id: string
  level: NotificationLevel
  type: NotificationType
  trigger_offset_sec: number
  dish_id: string | null
  task_id?: string | null
  action: string
  device_id?: string | null
  parameters: Record<string, unknown>
  message: string
  created_at: string
}
export interface TimelineResource { id: string; label: string; tone: 'gold' | 'cyan' | 'violet' | 'slate' }
export interface ScheduleDiff { task_id: string; action: string; type: DiffType; detail: string }

export type ReplanEventType = 'TASK_COMPLETED' | 'TASK_DELAYED' | 'DISH_ADDED' | 'DEVICE_UNAVAILABLE'
export interface ScheduleRequest { [key: string]: unknown }
export interface ReplanEvent {
  schema_version: '1.0'
  event_id: string
  schedule_id: string
  event_type: ReplanEventType
  occurred_at: string
  payload: Record<string, unknown>
}
export interface ReplanChange {
  task_id: string
  change_type: DiffType | 'CANCELLED'
  old_start_offset_sec?: number | null
  new_start_offset_sec?: number | null
  old_resources?: string[]
  new_resources?: string[]
}
export interface ReplanResponse {
  schema_version: '1.0'
  event_id: string
  previous_schedule_id: string
  schedule: ScheduleResponse
  changes: ReplanChange[]
  disruption_metrics: { start_offset_total_sec: number; resource_change_count: number; order_change_count: number; notified_task_change_count: number }
  disruption_score: number
}
export interface ReplanResult { schedule: DashboardSchedule; changes: ScheduleDiff[]; notifications: Notification[]; disruptionScore: number }
