import { useEffect, useMemo, useState } from 'react'
import { MetricCard } from './MetricCard'
import { Timeline } from './Timeline'
import { api, apiMode } from '../api/client'
import { classifyError } from '../lib/errors'
import { deriveDashboardMetrics } from '../lib/metrics'
import { apiModeLabel, formatResources } from '../lib/presentation'
import { setMockFault, type MockFault } from '../mock/api'
import { initialSchedule } from '../mock/schedule'
import type { DashboardSchedule, DashboardTask, Notification, ScheduleDiff } from '../types/contracts'
import '../styles.css'

const statusLabel: Record<DashboardTask['status'], string> = { PENDING: '待执行', LOCKED: '已锁定', RUNNING: '执行中', DELAYED: '已延迟', COMPLETED: '已完成', EXCEPTION: '异常', CANCELLED: '已取消' }
const diffLabel: Record<ScheduleDiff['type'], string> = { ADDED: '新增', REMOVED: '取消', MOVED: '时间调整', RESOURCE_CHANGED: '设备调整', UNCHANGED: '不变', LOCKED: '已完成' }
interface ExecutionDashboardProps { initialSchedule?: DashboardSchedule }
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

export default function ExecutionDashboard({ initialSchedule: providedSchedule }: ExecutionDashboardProps) {
  const seed = providedSchedule ?? initialSchedule
  const [schedule, setSchedule] = useState(seed)
  const [tasks, setTasks] = useState(seed.tasks)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(seed.tasks[0]?.task_id ?? null)
  const [resourceFilter, setResourceFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<'ALL' | DashboardTask['status']>('ALL')
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [diffs, setDiffs] = useState<ScheduleDiff[]>([])
  const [toast, setToast] = useState('计划已生成，可以开始做饭')
  const [fault, setFault] = useState<MockFault>('none')
  const selected = tasks.find(task => task.task_id === selectedId) ?? null
  const canStart = selected?.status === 'PENDING'
  const canComplete = selected?.status === 'RUNNING' || selected?.status === 'DELAYED'
  const canDelay = selected?.status === 'RUNNING'
  const hasDevice = selected?.assigned_resources.some(resource => !resource.startsWith('operator_')) ?? false
  const derived = useMemo(() => deriveDashboardMetrics(schedule.metrics, tasks), [schedule.metrics, tasks])
  const resources = schedule.resources
  const filteredTasks = tasks.filter(task => statusFilter === 'ALL' || task.status === statusFilter)

  useEffect(() => { if (!tasks.some(task => task.task_id === selectedId)) setSelectedId(tasks[0]?.task_id ?? null) }, [tasks, selectedId])
  useEffect(() => {
    if (providedSchedule || apiMode === 'MOCK API') { setLoading(false); return }
    let active = true
    void api.getSchedule().then(next => { if (active) { setSchedule(next); setTasks(next.tasks) } }).catch(() => { if (active) setError('计划加载失败，当前展示本地演示数据') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [providedSchedule])

  function pushNotification(notification: Notification) { setNotifications(current => [notification, ...current].slice(0, 5)); setToast(notification.action) }
  async function updateSelected(next: 'RUNNING' | 'COMPLETED' | 'DELAYED' | 'EXCEPTION') {
    if (!selected || selected.locked) { setToast('这一步已经锁定，不能直接修改'); return }
    setLoading(true); setError(null)
    try { const result = await api.postEvent(selected, next, schedule); setSchedule(result.schedule); setTasks(result.schedule.tasks); setDiffs(result.changes); result.notifications.forEach(pushNotification) }
    catch (caught) { const message = classifyError(caught, '操作失败，请重试'); setError(message); setToast(message) } finally { setLoading(false) }
  }
  async function handleAddDish() {
    setLoading(true); setError(null)
    try { const result = await api.addDish(schedule); setSchedule(result.schedule); setTasks(result.schedule.tasks); setDiffs(result.changes); result.notifications.forEach(pushNotification) }
    catch (caught) { const message = classifyError(caught, '临时加菜失败，请重试'); setError(message); setToast(message) } finally { setLoading(false) }
  }

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark">灶</div><div><strong>灶序</strong><span>智能做饭指挥台</span></div></div><div className="session"><span className="status-dot" />{apiModeLabel(apiMode)} · 预计 12:30 开饭<button className="avatar" aria-label="当前用户">H</button></div></header>
    <div className="content">
      <section className="hero"><div><p className="eyebrow">今日烹饪安排</p><h1>按这个顺序做，<em>尽量一起出锅。</em></h1><p className="subtitle">{new Set(tasks.map(task => task.dish_id)).size} 道菜 · 单人操作 · 系统正在协调设备和时间</p></div><div className="hero-actions"><button className="secondary" onClick={() => { setSchedule(seed); setTasks(seed.tasks); setNotifications([]); setDiffs([]); setToast('计划已恢复') }}>恢复计划</button><button className="primary" disabled={loading} onClick={() => void handleAddDish()}>＋ 临时加菜</button></div></section>
      {error && <div className="error-banner">{error}</div>}
      <section className="metric-grid"><MetricCard label="完成进度" value={`${derived.progress}%`} hint={`${derived.completed} / ${derived.total} 步已完成`} accent="orange" /><MetricCard label="预计完成" value={derived.estimatedFinish} hint={derived.delayHint} accent="cyan" /><MetricCard label="出锅间隔" value={derived.finishSpread} hint="目标不超过 5 分钟" accent="violet" /><MetricCard label="节省时间" value={derived.compression} hint="相较逐道完成" accent="slate" /><MetricCard label="计划检查" value={derived.conflicts} hint="设备、先后顺序、人工" accent="green" /></section>
      <section className="toolbar"><div className="filter-group"><span>查看</span><select value={resourceFilter} onChange={event => setResourceFilter(event.target.value)}><option value="all">全部设备</option>{resources.map(resource => <option value={resource.id} key={resource.id}>{resource.label.split(' · ')[0]}</option>)}</select><span>进度</span><select value={statusFilter} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)}><option value="ALL">全部步骤</option>{Object.entries(statusLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>{apiMode === 'MOCK API' && <div className="filter-group drill"><span>演示情况</span><select aria-label="故障演练" value={fault} onChange={event => { const next = event.target.value as MockFault; setFault(next); setMockFault(next) }}><option value="none">正常运行</option><option value="infeasible">计划冲突</option><option value="timeout">计算超时</option><option value="network">连接中断</option></select></div>}<span className="toolbar-note">{apiModeLabel(apiMode)}</span></section>
      <Timeline tasks={tasks} resources={resources} selectedId={selectedId} resourceFilter={resourceFilter} onSelect={task => setSelectedId(task.task_id)} />
      <section className="lower-grid"><div className="task-panel"><div className="panel-heading"><div><p className="eyebrow">烹饪步骤</p><h2>接下来做什么</h2></div><span>{filteredTasks.length} / {tasks.length} 步</span></div><div className="task-list">{filteredTasks.map(task => <button aria-label={`${task.action}，${statusLabel[task.status]}`} className={`task-row ${selectedId === task.task_id ? 'active' : ''}`} key={task.task_id} onClick={() => setSelectedId(task.task_id)}><span className={`task-icon ${task.status.toLowerCase()}`}>{task.status === 'COMPLETED' ? '✓' : task.status === 'RUNNING' ? '◉' : task.status === 'EXCEPTION' ? '!' : '·'}</span><span className="task-main"><b>{task.action}</b><small>{formatResources(task.assigned_resources)}</small></span><span className={`badge ${task.status.toLowerCase()}`}>{statusLabel[task.status]}</span></button>)}</div></div><aside className="detail-panel"><p className="eyebrow">当前步骤</p>{selected ? <><div className="detail-title"><h2>{selected.action}</h2>{selected.locked && <span>已锁定</span>}</div><div className="detail-row"><span>安排时间</span><b>{clock(selected.start_offset_sec)} — {clock(selected.end_offset_sec)}</b></div><div className="detail-row"><span>需要使用</span><b>{formatResources(selected.assigned_resources)}</b></div><div className="event-actions">{canStart && <button disabled={loading} onClick={() => void updateSelected('RUNNING')}>开始执行</button>}{canComplete && <button disabled={loading} onClick={() => void updateSelected('COMPLETED')}>完成任务</button>}{canDelay && <button disabled={loading} onClick={() => void updateSelected('DELAYED')}>发生延迟</button>}{hasDevice && <button className="danger" disabled={loading} onClick={() => void updateSelected('EXCEPTION')}>设备异常</button>}</div></> : <p>选择一个步骤查看详细安排</p>}</aside></section>
      <section className="insight-grid"><div className="notification-panel"><div className="panel-heading"><div><p className="eyebrow">提醒</p><h2>需要你注意</h2></div><span>{notifications.length} 条</span></div><div className="panel-scroll">{notifications.length ? notifications.map(item => <div className={`notification ${item.level === 'error' ? 'danger' : item.level}`} key={item.notification_id}><span className="notification-mark" /><div><b>{item.action}</b><small>{item.message} · {new Date(item.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small></div></div>) : <p className="empty-state">暂无提醒，开始执行后会在这里告诉你下一步。</p>}</div></div><div className="diff-panel"><div className="panel-heading"><div><p className="eyebrow">计划调整</p><h2>变动说明</h2></div><span>{diffs.length} 项</span></div><div className="panel-scroll">{diffs.length ? diffs.map(diff => <div className="diff-row" key={diff.task_id}><span className={`diff-type ${diff.type.toLowerCase()}`}>{diffLabel[diff.type]}</span><b>{diff.action}</b><small>{diff.detail}</small></div>) : <p className="empty-state">加菜、延迟或设备异常后，会在这里说明计划怎么变。</p>}</div></div></section>
      <div className="toast"><span className="toast-dot" />{toast}<span className="toast-time">刚刚</span></div>
    </div>
  </main>
}
