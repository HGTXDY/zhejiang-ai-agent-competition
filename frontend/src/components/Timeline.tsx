import { useMemo } from 'react'
import type { DashboardTask, TimelineResource } from '../types/contracts'

interface Props { tasks: DashboardTask[]; resources: TimelineResource[]; selectedId: string | null; resourceFilter: string; onSelect: (task: DashboardTask) => void }
const MIN_WINDOW = 2700
const STEP = 300
const statusLabel: Record<DashboardTask['status'], string> = { PENDING: '待执行', LOCKED: '已锁定', RUNNING: '执行中', DELAYED: '已延迟', COMPLETED: '已完成', EXCEPTION: '异常', CANCELLED: '已取消' }
const format = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`

export function Timeline({ tasks, resources, selectedId, resourceFilter, onSelect }: Props) {
  const windowSize = useMemo(() => Math.max(MIN_WINDOW, ...tasks.map(task => task.end_offset_sec + STEP)), [tasks])
  const ticks = Array.from({ length: Math.floor(windowSize / STEP) + 1 }, (_, index) => index * STEP)
  const visibleResources = resourceFilter === 'all' ? resources : resources.filter(resource => resource.id === resourceFilter)
  const renderedTasks = tasks.filter(task => visibleResources.some(resource => task.assigned_resources.includes(resource.id)))
  const nowOffset = Math.min(720, windowSize)

  return <section className="timeline-card">
    <div className="timeline-title"><div><p className="eyebrow">LIVE SCHEDULE</p><h2>资源轨道 · 执行排程</h2><p className="timeline-caption">按 ScheduleResponse 原样渲染 · 不在前端修改排程</p></div><div className="timeline-status"><span className="live-pill"><i />实时模拟</span></div></div>
    <div className="timeline-legend"><span><i className="legend-dot manual" />人工</span><span><i className="legend-dot automatic" />自动设备</span><span><i className="legend-dot waiting" />等待/待执行</span><span><i className="legend-dot issue" />异常</span></div>
    {visibleResources.length === 0 || renderedTasks.length === 0 ? <div className="timeline-empty"><strong>暂无可展示的排程</strong><span>当前筛选条件下没有任务，请切换资源或返回排程配置。</span></div> : <div className="timeline-scroll"><div className="timeline-grid-header"><div className="resource-label">资源</div><div className="axis">{ticks.map(tick => <span key={tick} style={{ left: `${tick / windowSize * 100}%` }}>{format(tick)}</span>)}<i className="now-line" style={{ left: `${nowOffset / windowSize * 100}%` }} /></div></div>
      {visibleResources.map(resource => { const resourceTasks = tasks.filter(task => task.assigned_resources.includes(resource.id)); return <div className="timeline-row" key={resource.id}><div className="resource-label"><b>{resource.label.split(' · ')[0]}</b><small>{resource.label.split(' · ')[1] ?? resource.id}</small></div><div className="track">{ticks.slice(1).map(tick => <i className="grid-line" key={tick} style={{ left: `${tick / windowSize * 100}%` }} />)}<i className="now-line" style={{ left: `${nowOffset / windowSize * 100}%` }} />{resourceTasks.map(task => <button aria-label={`${task.action}，${statusLabel[task.status]}，${format(task.start_offset_sec)}至${format(task.end_offset_sec)}`} className={`task-bar ${resource.tone} ${task.status.toLowerCase()} ${task.locked ? 'locked' : ''} ${selectedId === task.task_id ? 'selected' : ''}`} key={`${resource.id}-${task.task_id}`} style={{ left: `${task.start_offset_sec / windowSize * 100}%`, width: `${Math.max((task.end_offset_sec - task.start_offset_sec) / windowSize * 100, 3)}%` }} onClick={() => onSelect(task)} title={`${task.action} · ${statusLabel[task.status]}`}><b>{task.action}</b><small>{format(task.start_offset_sec)} — {format(task.end_offset_sec)} · {statusLabel[task.status]}{task.locked ? ' · 锁定' : ''}</small></button>)}</div></div> })}
    </div>}
  </section>
}
