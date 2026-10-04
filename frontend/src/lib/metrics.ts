/** Pure dashboard-metric derivations, kept free of React for unit testing.
 *
 * The schedule response carries `makespan_sec`, `target_delay_sec` and
 * `makespan_compression_ratio`; the dashboard renders them through these
 * helpers so the "预计完成 / 较目标晚" numbers are derived from the schedule,
 * never hard-coded in the component.
 */
import type { ScheduleMetrics } from '../types/contracts'

/** Session start in minutes after midnight (the lunch batch anchor, 12:30). */
export const SESSION_START_MINUTES = 12 * 60 + 30

export function formatClock(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60) % 24
  const minutes = totalMinutes % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function formatDuration(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60))
  return `${minutes}′`
}

export function estimatedFinish(makespanSec: number, startMinutes = SESSION_START_MINUTES): string {
  return formatClock(startMinutes + Math.round(makespanSec / 60))
}

export function delayHint(targetDelaySec: number): string {
  return targetDelaySec > 0 ? `较目标晚 ${formatDuration(targetDelaySec)}` : '按目标准时完成'
}

/** Percentage of serial time saved by parallelising (0..100). */
export function compressionPercent(ratio: number): number {
  return Math.round(Math.max(0, Math.min(1, 1 - ratio)) * 100)
}

export interface DerivedMetrics {
  progress: number
  completed: number
  total: number
  estimatedFinish: string
  delayHint: string
  finishSpread: string
  compression: string
  conflicts: string
}

export function deriveDashboardMetrics(metrics: ScheduleMetrics, tasks: { task_id: string; end_offset_sec: number; status: string }[]): DerivedMetrics {
  const completed = tasks.filter(task => task.status === 'COMPLETED').length
  const total = tasks.length
  const makespanSec = tasks.reduce((max, task) => Math.max(max, task.end_offset_sec), metrics.makespan_sec)
  return {
    progress: total ? Math.round((completed / total) * 100) : 0,
    completed,
    total,
    estimatedFinish: estimatedFinish(makespanSec),
    delayHint: delayHint(metrics.target_delay_sec),
    finishSpread: formatDuration(metrics.finish_spread_sec),
    compression: `${compressionPercent(metrics.makespan_compression_ratio)}%`,
    conflicts: `${metrics.device_conflicts} 冲突`,
  }
}
