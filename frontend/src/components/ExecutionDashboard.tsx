import { useEffect, useMemo, useRef, useState } from 'react'
import { MetricCard } from './MetricCard'
import { Timeline } from './Timeline'
import { api, apiMode } from '../api/client'
import { productApi } from '../api/product'
import { classifyError } from '../lib/errors'
import { deriveDashboardMetrics } from '../lib/metrics'
import { apiModeLabel, formatResources } from '../lib/presentation'
import { setMockFault, type MockFault } from '../mock/api'
import { initialSchedule } from '../mock/schedule'
import { recipeCatalog } from '../mock/recipes'
import DishPickerDialog from './DishPickerDialog'
import type { DashboardSchedule, DashboardTask, DeviceType, Notification, ScheduleDiff } from '../types/contracts'
import type { AgentCommandResponse, RecipeSummary } from '../types/product'
import '../styles.css'

const statusLabel: Record<DashboardTask['status'], string> = { PENDING: '待执行', LOCKED: '已锁定', RUNNING: '执行中', DELAYED: '已延迟', COMPLETED: '已完成', EXCEPTION: '异常', CANCELLED: '已取消' }
const diffLabel: Record<ScheduleDiff['type'], string> = { ADDED: '新增', REMOVED: '取消', MOVED: '时间调整', RESOURCE_CHANGED: '设备调整', UNCHANGED: '不变', LOCKED: '已完成' }
const DEVICE_TYPE_WORDS: [string, DeviceType][] = [
  ['净咖一体机', 'water_purifier'], ['油烟机', 'range_hood'], ['洗碗机', 'dishwasher'], ['净水机', 'water_purifier'],
  ['蒸箱', 'steamer'], ['蒸锅', 'steamer'], ['烤箱', 'oven'], ['冰箱', 'refrigerator'], ['炉灶', 'stove'], ['灶台', 'stove'], ['烟机', 'range_hood'], ['灶', 'stove'],
]
const DEVICE_TYPE_LABELS: Record<DeviceType, string> = { stove: '灶台', steamer: '蒸箱', oven: '烤箱', refrigerator: '冰箱', dishwasher: '洗碗机', range_hood: '烟机', water_purifier: '净水机' }
const detectDeviceType = (message: string): DeviceType | null => {
  for (const [word, type] of DEVICE_TYPE_WORDS) if (message.includes(word)) return type
  return null
}
interface ExecutionDashboardProps {
  initialSchedule?: DashboardSchedule
  recipes?: RecipeSummary[]
  onBackToPlanner?: () => void
}
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
const preservePresentation = (next: DashboardSchedule, current: DashboardSchedule): DashboardSchedule => {
  const knownDishes = new Map(current.tasks.map(task => [task.dish_id, task.dish_name]))
  return {
    ...next,
    target_time: next.target_time ?? current.target_time,
    tasks: next.tasks.map(task => ({ ...task, dish_name: task.dish_name ?? knownDishes.get(task.dish_id) })),
  }
}

export default function ExecutionDashboard({ initialSchedule: providedSchedule, recipes = recipeCatalog, onBackToPlanner }: ExecutionDashboardProps) {
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
  const [completion, setCompletion] = useState<{ schedule: DashboardSchedule; notifications: Notification[]; targetId: string; revealed: number } | null>(null)
  const [toast, setToast] = useState('计划已生成，可以开始做饭')
  const [fault, setFault] = useState<MockFault>('none')
  const [addDishOpen, setAddDishOpen] = useState(false)
  const [ganttOpen, setGanttOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [chatMessages, setChatMessages] = useState<{ role: 'agent' | 'user'; text: string }[]>([{ role: 'agent', text: '你可以直接告诉我现场发生了什么：排骨慢了十分钟、蒸箱坏了、鲈鱼已经蒸上了，或者「现在多一个灶台」让我重新排程。' }])
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const selected = tasks.find(task => task.task_id === selectedId) ?? null
  const canStart = selected?.status === 'PENDING'
  const canComplete = selected?.status === 'RUNNING' || selected?.status === 'DELAYED'
  const canDelay = selected?.status === 'RUNNING'
  const hasDevice = selected?.assigned_resources.some(resource => !resource.startsWith('operator_')) ?? false
  // A completion is walked through one 下一步 at a time: each click reveals the
  // next reminder, and only once they have all popped out does 结束任务 appear
  // to finalise the step and advance to the next task. Plan changes (变动说明)
  // are driven separately by the on-site adjustments, not by step completion.
  const completionSteps = completion ? completion.notifications.length : 0
  const completionDone = completion ? completion.revealed >= completionSteps : false
  const hasExecutionHistory = schedule.schedule_id !== seed.schedule_id
    || tasks.length !== seed.tasks.length
    || tasks.some(task => {
      const original = seed.tasks.find(item => item.task_id === task.task_id)
      return !original || task.status !== original.status || task.locked !== original.locked
        || task.start_offset_sec !== original.start_offset_sec || task.end_offset_sec !== original.end_offset_sec
        || task.assigned_resources.join(',') !== original.assigned_resources.join(',')
    })
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
  useEffect(() => {
    const list = chatScrollRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [chatMessages, chatBusy, chatOpen])

  function pushNotification(notification: Notification) {
    // task_due reminders are regenerated on every replan with a stable id, so a
    // step completion can return the same reminder again; skip duplicates by id.
    setNotifications(current => current.some(item => item.notification_id === notification.notification_id) ? current : [notification, ...current].slice(0, 5))
    setToast(notification.action)
  }
  const nextActionableId = (list: DashboardTask[], afterId: string): string | null => {
    const actionable = (task: DashboardTask) => task.status !== 'COMPLETED' && !task.locked
    const index = list.findIndex(task => task.task_id === afterId)
    const ordered = index >= 0 ? [...list.slice(index + 1), ...list.slice(0, index)] : list
    return ordered.find(actionable)?.task_id ?? null
  }
  function revealCompletion(state: { notifications: Notification[] }, index: number) {
    const notification = state.notifications[index]
    if (notification) pushNotification(notification)
  }
  async function stepForward(target = selected) {
    if (!target) return
    setLoading(true); setError(null)
    try {
      if (!completion) {
        const result = await api.postEvent(target, 'COMPLETED', schedule)
        // The backend re-emits the whole key-node reminder plan on every replan.
        // Only reveal reminders that have not been shown yet (and cap them to the
        // box size) so each 下一步 surfaces a distinct, new reminder instead of
        // replaying already-seen notices on every completed step.
        const seen = new Set(notifications.map(item => item.notification_id))
        const upcoming = result.notifications.filter(item => !seen.has(item.notification_id)).slice(0, 5)
        const next = { schedule: preservePresentation(result.schedule, schedule), notifications: upcoming, targetId: target.task_id, revealed: 1 }
        revealCompletion(next, 0)
        setCompletion(next)
      } else {
        revealCompletion(completion, completion.revealed)
        setCompletion({ ...completion, revealed: completion.revealed + 1 })
      }
    }
    catch (caught) { const message = classifyError(caught, '操作失败，请重试'); setError(message); setToast(message) } finally { setLoading(false) }
  }
  function finishStep() {
    if (!completion) return
    setSchedule(completion.schedule)
    setTasks(completion.schedule.tasks)
    setSelectedId(nextActionableId(completion.schedule.tasks, completion.targetId))
    setCompletion(null)
    setToast('当前步骤已完成，已进入下一步')
  }
  async function updateSelected(next: 'RUNNING' | 'COMPLETED' | 'DELAYED' | 'EXCEPTION', target = selected, options?: { delaySec?: number; deviceId?: string }) {
    if (!target || target.locked) { setToast('这一步已经锁定，不能直接修改'); return }
    setLoading(true); setError(null)
    try {
      const result = await api.postEvent(target, next, schedule, options)
      const enriched = preservePresentation(result.schedule, schedule)
      setSchedule(enriched); setTasks(enriched.tasks); if (next === 'DELAYED' || next === 'EXCEPTION') setDiffs(current => [...current, ...result.changes]); result.notifications.forEach(pushNotification)
      // Completing a step advances the selection to the next actionable step so
      // the operator can keep going without clicking through the task list.
      if (next === 'COMPLETED') setSelectedId(nextActionableId(enriched.tasks, target.task_id))
    }
    catch (caught) { const message = classifyError(caught, '操作失败，请重试'); setError(message); setToast(message) } finally { setLoading(false) }
  }
  async function interpretCommand(message: string): Promise<AgentCommandResponse> {
    if (apiMode === 'HTTP API') return productApi.interpretAgentCommand({ message, tasks, recipes })
    const mentionedTask = tasks.find(task => message.includes(task.action) || Boolean(task.dish_name && message.includes(task.dish_name))) ?? selected
    const recipe = recipes.find(item => message.includes(item.name))
    const minutes = Number(message.match(/(\d+)\s*分钟/)?.[1] ?? 1)
    if (/加一道|加菜|再做/.test(message)) return { intent: 'add_dish', reply: recipe ? '已识别临时加菜。' : '请说出菜谱库中的菜名。', ready: Boolean(recipe), recipe_id: recipe?.recipe_id }
    if (/多一个|多一台|多加|再加|加一个|加一台|加两个|多两个|新增|再来/.test(message)) {
      const deviceType = detectDeviceType(message)
      if (deviceType) return { intent: 'add_device', reply: `已识别新增${DEVICE_TYPE_LABELS[deviceType]}，将重新排程。`, ready: true, device_type: deviceType, count: 1 }
      return { intent: 'add_device', reply: '请说明要新增哪种设备（如灶台、烤箱、蒸箱）。', ready: false }
    }
    if (/坏了|不可用|故障/.test(message)) { const device_id = message.includes('蒸箱') ? 'steamer_1' : message.includes('烤箱') ? 'oven_1' : message.includes('灶') ? 'stove_1' : null; return { intent: 'device_unavailable', reply: device_id ? '已识别设备异常，将重新安排。' : '请说明是哪台设备不可用。', ready: Boolean(device_id), device_id } }
    if (/慢了|延迟|晚了/.test(message)) return { intent: 'task_delayed', reply: mentionedTask ? '已识别步骤延迟，将重新计算。' : '请先选择发生延迟的步骤。', ready: Boolean(mentionedTask), task_id: mentionedTask?.task_id, delay_sec: minutes * 60 }
    if (/完成|做好了|已经好了/.test(message)) return { intent: 'task_completed', reply: mentionedTask ? '已识别步骤完成。' : '请先选择已经完成的步骤。', ready: Boolean(mentionedTask), task_id: mentionedTask?.task_id }
    if (/开始|做上了|蒸上了|烤上了/.test(message)) return { intent: 'task_started', reply: mentionedTask ? '已识别步骤开始。' : '请先选择已经开始的步骤。', ready: Boolean(mentionedTask), task_id: mentionedTask?.task_id }
    return { intent: 'unknown', reply: '我可以处理步骤开始、完成、延迟、设备故障、临时加菜或新增设备。', ready: false }
  }
  async function runCommand(text = chatInput) {
    const message = text.trim(); if (!message || chatBusy || loading) return
    setChatInput('')
    setChatMessages(current => [...current, { role: 'user', text: message }])
    setChatBusy(true); setError(null)
    try {
      const intent = await interpretCommand(message)
      setChatMessages(current => [...current, { role: 'agent', text: intent.reply }])
      if (!intent.ready) return
      if (intent.intent === 'add_dish') {
        const recipe = recipes.find(item => item.recipe_id === intent.recipe_id)
        if (recipe) await handleAddDish(recipe)
        return
      }
      if (intent.intent === 'add_device') {
        if (intent.device_type) await addDeviceToSchedule(intent.device_type, intent.count ?? 1)
        return
      }
      const target = tasks.find(task => task.task_id === intent.task_id) ?? (intent.device_id ? tasks.find(task => task.assigned_resources.includes(intent.device_id!)) : selected)
      if (!target) { setChatMessages(current => [...current, { role: 'agent', text: '没有找到对应步骤，请先在下方点选一个步骤。' }]); return }
      if (intent.intent === 'task_started') await updateSelected('RUNNING', target)
      if (intent.intent === 'task_completed') await updateSelected('COMPLETED', target)
      if (intent.intent === 'task_delayed') await updateSelected('DELAYED', target, { delaySec: intent.delay_sec })
      if (intent.intent === 'device_unavailable') await updateSelected('EXCEPTION', target, { deviceId: intent.device_id ?? undefined })
    } catch (caught) {
      const message = classifyError(caught, '指令处理失败，请重试')
      setError(message)
      setChatMessages(current => [...current, { role: 'agent', text: message }])
    } finally { setChatBusy(false) }
  }
  async function addDeviceToSchedule(deviceType: DeviceType, count: number) {
    setLoading(true); setError(null)
    try {
      const result = await api.addDevice(schedule, deviceType, count)
      const enriched = preservePresentation(result.schedule, schedule)
      setSchedule(enriched); setTasks(enriched.tasks); setDiffs(current => [...current, ...result.changes]); result.notifications.forEach(pushNotification)
    } catch (caught) {
      const message = classifyError(caught, '新增设备失败，请重试')
      setError(message); setToast(message)
    } finally { setLoading(false) }
  }
  async function handleAddDish(recipe: RecipeSummary) {
    setLoading(true); setError(null)
    try { const result = await api.addDish(schedule, recipe); const enriched = preservePresentation(result.schedule, schedule); setSchedule(enriched); setTasks(enriched.tasks); setDiffs(current => [...current, ...result.changes]); result.notifications.forEach(pushNotification); setAddDishOpen(false) }
    catch (caught) { const message = classifyError(caught, '临时加菜失败，请重试'); setError(message); setToast(message) } finally { setLoading(false) }
  }

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark">灶</div><div><strong>灶序</strong><span>智能做饭指挥台</span></div></div><div className="session"><span className="status-dot" />{apiModeLabel(apiMode)} · 预计 {schedule.target_time ?? '按计划'} 开饭<button className="avatar" aria-label="当前用户">H</button></div></header>
    <div className="content">
      <section className="hero"><div><p className="eyebrow">今日烹饪安排</p><h1>按这个顺序做，<em>尽量一起出锅。</em></h1><p className="subtitle">{new Set(tasks.map(task => task.dish_id)).size} 道菜 · 单人操作 · 系统正在协调设备和时间</p></div><div className="hero-actions">{onBackToPlanner && <button className="secondary" disabled={loading} onClick={onBackToPlanner}>← 返回计划</button>}<button className="secondary" disabled={loading || hasExecutionHistory} title={hasExecutionHistory ? '执行状态已变化，不能回滚到最初计划' : '恢复初始显示'} onClick={() => { setSchedule(seed); setTasks(seed.tasks); setNotifications([]); setDiffs([]); setToast('计划已恢复') }}>恢复计划</button><button className="primary" disabled={loading} onClick={() => setAddDishOpen(true)}>＋ 临时加菜</button></div></section>
      {error && <div className="error-banner">{error}</div>}
      <section className="metric-grid"><MetricCard label="完成进度" value={`${derived.progress}%`} hint={`${derived.completed} / ${derived.total} 步已完成`} accent="orange" /><MetricCard label="预计完成" value={derived.estimatedFinish} hint={derived.delayHint} accent="cyan" /><MetricCard label="出锅间隔" value={derived.finishSpread} hint="目标不超过 5 分钟" accent="violet" /><MetricCard label="节省时间" value={derived.compression} hint="相较逐道完成" accent="slate" /><MetricCard label="计划检查" value={derived.conflicts} hint="设备、先后顺序、人工" accent="green" /></section>
      <section className="dashboard-grid">
        <div className="task-panel">
          <div className="panel-heading"><div><p className="eyebrow">烹饪步骤</p><h2>接下来做什么</h2></div><span>{filteredTasks.length} / {tasks.length} 步</span></div>
          <div className="panel-filters"><div className="filter-group"><span>进度</span><select value={statusFilter} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)}><option value="ALL">全部步骤</option>{Object.entries(statusLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>{apiMode === 'MOCK API' && <div className="filter-group drill"><span>演示情况</span><select aria-label="故障演练" value={fault} onChange={event => { const next = event.target.value as MockFault; setFault(next); setMockFault(next) }}><option value="none">正常运行</option><option value="infeasible">计划冲突</option><option value="timeout">计算超时</option><option value="network">连接中断</option></select></div>}</div>
          <div className="task-list">{filteredTasks.map(task => <button aria-label={`${task.action}，${statusLabel[task.status]}`} className={`task-row ${selectedId === task.task_id ? 'active' : ''}`} key={task.task_id} onClick={() => setSelectedId(task.task_id)}><span className={`task-icon ${task.status.toLowerCase()}`}>{task.status === 'COMPLETED' ? '✓' : task.status === 'RUNNING' ? '◉' : task.status === 'EXCEPTION' ? '!' : '·'}</span><span className="task-main"><b>{task.action}</b><small>{formatResources(task.assigned_resources)}</small></span><span className={`badge ${task.status.toLowerCase()}`}>{statusLabel[task.status]}</span></button>)}</div>
        </div>
        <div className="detail-column">
          <aside className="detail-panel"><p className="eyebrow">当前步骤</p>{selected ? <><div className="detail-title"><h2>{selected.action}</h2>{selected.locked && <span>已锁定</span>}</div><div className="detail-row"><span>安排时间</span><b>{clock(selected.start_offset_sec)} — {clock(selected.end_offset_sec)}</b></div><div className="detail-row"><span>需要使用</span><b>{formatResources(selected.assigned_resources)}</b></div><div className="event-actions">{canStart && <button disabled={loading} onClick={() => void updateSelected('RUNNING')}>开始执行</button>}{canComplete && !completionDone && <button disabled={loading} onClick={() => void stepForward()}>下一步 →</button>}{canComplete && completionDone && <button disabled={loading} onClick={finishStep}>结束任务</button>}{canDelay && !completion && <button disabled={loading} onClick={() => void updateSelected('DELAYED')}>发生延迟</button>}{hasDevice && !completion && <button className="danger" disabled={loading} onClick={() => void updateSelected('EXCEPTION')}>设备异常</button>}</div></> : <p>选择一个步骤查看详细安排</p>}</aside>
          <button type="button" className="launch-icon" aria-label="甘特图" title="查看甘特图" onClick={() => setGanttOpen(true)}><span className="glyph" aria-hidden="true">▦</span><span>甘特图</span></button>
        </div>
        <div className="notification-panel"><div className="panel-heading"><div><p className="eyebrow">提醒</p><h2>需要你注意</h2></div><span>{notifications.length} 条</span></div><div className="panel-scroll">{notifications.length ? notifications.map(item => <div className={`notification ${item.level === 'error' ? 'danger' : item.level}`} key={item.notification_id}><span className="notification-mark" /><div><b>{item.action}</b><small>{item.message} · {new Date(item.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small></div></div>) : <p className="empty-state">暂无提醒，开始执行后会在这里告诉你下一步。</p>}</div></div>
        <div className="diff-panel">
          <div className="panel-heading"><div><p className="eyebrow">现场调整</p><h2>相较原计划</h2></div><span>{diffs.length} 项</span></div>
          <div className="panel-scroll">{diffs.length ? diffs.map((diff, index) => <div className="diff-row" key={`${diff.task_id}-${index}`}><span className={`diff-type ${diff.type.toLowerCase()}`}>{diffLabel[diff.type]}</span><b>{diff.action}</b><small>{diff.detail}</small></div>) : <p className="empty-state">通过现场改动（加菜、延迟、设备异常）调整计划后，这里会说明相较于原计划改动了什么。</p>}</div>
          <button type="button" className="launch-icon" aria-label="现场改动" title="现场改动" disabled={loading} onClick={() => setChatOpen(true)}><span className="glyph" aria-hidden="true">✦</span><span>现场改动</span></button>
        </div>
      </section>
      <div className="toast"><span className="toast-dot" />{toast}<span className="toast-time">刚刚</span></div>
      {addDishOpen && <DishPickerDialog recipes={recipes} existingDishIds={new Set(tasks.map(task => task.dish_id))} loading={loading} onClose={() => setAddDishOpen(false)} onConfirm={recipe => void handleAddDish(recipe)} />}
      {chatOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !chatBusy) setChatOpen(false) }}>
        <section className="model-dialog chat-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-title">
          <div className="dialog-heading"><div><p className="eyebrow">执行现场</p><h2 id="chat-title">现场改动</h2><p>在这里告诉我现场发生了什么，系统会据此真实重新排程。</p></div><button type="button" className="dialog-close" aria-label="关闭执行指令" onClick={() => setChatOpen(false)} disabled={chatBusy}>×</button></div>
          <div className="chat-messages" ref={chatScrollRef} aria-live="polite">{chatMessages.map((message, index) => <div className={`chat-bubble ${message.role}`} key={index}>{message.text}</div>)}{chatBusy && <div className="chat-bubble agent">正在处理…</div>}</div>
          <form className="chat-composer" onSubmit={event => { event.preventDefault(); void runCommand() }}><input aria-label="输入执行指令" value={chatInput} onChange={event => setChatInput(event.target.value)} placeholder="例如：现在多一个灶台 / 蒸箱坏了 / 排骨慢了 10 分钟" disabled={chatBusy || loading} /><button type="submit" disabled={!chatInput.trim() || chatBusy || loading}>发送</button></form>
        </section>
      </div>}
      {ganttOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setGanttOpen(false) }}>
        <section className="model-dialog gantt-dialog" role="dialog" aria-modal="true" aria-labelledby="gantt-title">
          <div className="dialog-heading"><div><p className="eyebrow">完整时间线</p><h2 id="gantt-title">甘特图</h2><p>完整展示菜品线程与设备占用，悬停查看工序详情。</p></div><button type="button" className="dialog-close" aria-label="关闭甘特图" onClick={() => setGanttOpen(false)}>×</button></div>
          <div className="gantt-toolbar"><div className="filter-group"><span>查看</span><select aria-label="按设备查看" value={resourceFilter} onChange={event => setResourceFilter(event.target.value)}><option value="all">全部设备</option>{resources.map(resource => <option value={resource.id} key={resource.id}>{resource.label.split(' · ')[0]}</option>)}</select></div></div>
          <Timeline tasks={tasks} resources={resources} selectedId={selectedId} resourceFilter={resourceFilter} targetTime={schedule.target_time} onSelect={task => setSelectedId(task.task_id)} />
        </section>
      </div>}
    </div>
  </main>
}
