import { useMemo, useState, type CSSProperties } from 'react'
import { autoUpdate, flip, FloatingPortal, offset, shift, useDismiss, useFloating, useFocus, useHover, useInteractions, useRole } from '@floating-ui/react'
import type { DashboardTask, TimelineResource } from '../types/contracts'
import { formatDuration, formatResources } from '../lib/presentation'

interface Props {
  tasks: DashboardTask[]
  resources: TimelineResource[]
  selectedId: string | null
  resourceFilter: string
  targetTime?: string
  onSelect: (task: DashboardTask) => void
}

interface DishLane { id: string; label: string; tasks: DashboardTask[]; subrows: DashboardTask[][] }
type TaskKind = 'manual' | 'automatic' | 'waiting' | 'idle'

const MIN_WINDOW = 900
const WINDOW_UNIT = 300
const TICK_STEPS = [300, 600, 900, 1800, 3600, 7200, 10800]
const MAX_TICKS = 5
const statusLabel: Record<DashboardTask['status'], string> = { PENDING: '待执行', LOCKED: '已排期', RUNNING: '执行中', DELAYED: '已延迟', COMPLETED: '已完成', EXCEPTION: '异常', CANCELLED: '已取消' }
const knownDishLabels: Record<string, string> = {
  braised_ribs: '红烧排骨', steamed_fish: '清蒸鲈鱼', baked_wings: '烤鸡翅', garlic_broccoli: '蒜蓉西兰花', mapo_tofu: '麻婆豆腐',
}
const processWords = /(预处理|备料|改刀|切配|装盘|腌制|焯水|烹制|烹饪|蒸制|清蒸|烘烤|烤制|翻炒|炒制|炖煮|收汁|完成)$/
const waitingWords = /(泡发|浸泡|醒面|静置|发酵|腌制|冷藏|解冻|等待|焖|焖制|入味)/
const preparationWords = /(预处理|备料|改刀|切配|装盘|处理|清洗|切成|去皮|去骨)/

const parseClock = (value?: string) => value && /^\d{2}:\d{2}$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null
const clockAt = (offsetSec: number, targetTime: string | undefined, planEndSec: number) => {
  const targetMinutes = parseClock(targetTime)
  if (targetMinutes == null) return `开始后 ${Math.round(offsetSec / 60)} 分`
  const absoluteMinutes = targetMinutes - planEndSec / 60 + offsetSec / 60
  const normalized = (Math.round(absoluteMinutes) % 1440 + 1440) % 1440
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`
}
const friendlyDishName = (dishId: string, tasks: DashboardTask[], index: number) => {
  const explicit = tasks.find(task => task.dish_name)?.dish_name
  if (explicit) return explicit
  if (knownDishLabels[dishId]) return knownDishLabels[dishId]
  const candidate = tasks.map(task => task.action.replace(processWords, '').trim()).filter(Boolean).sort((a, b) => b.length - a.length)[0]
  return candidate || `第 ${index + 1} 道菜`
}
const packSubrows = (tasks: DashboardTask[]) => {
  const rows: DashboardTask[][] = []
  for (const task of [...tasks].sort((a, b) => a.start_offset_sec - b.start_offset_sec || a.end_offset_sec - b.end_offset_sec)) {
    const available = rows.find(row => row[row.length - 1].end_offset_sec <= task.start_offset_sec)
    if (available) available.push(task)
    else rows.push([task])
  }
  return rows
}
const taskKind = (task: DashboardTask): TaskKind => {
  if (!task.assigned_resources.length) return 'idle'
  if (waitingWords.test(task.action)) return 'waiting'
  return task.assigned_resources.some(id => id.startsWith('operator_')) ? 'manual' : 'automatic'
}
const compactAction = (action: string, kind: TaskKind) => {
  if (waitingWords.test(action)) return '等待静置'
  if (kind === 'automatic') return action.replace(/^(使用)?(蒸箱|烤箱|灶具)?/, '').trim() || '设备执行'
  if (action.length <= 12) return action
  if (preparationWords.test(action)) return '备料 / 切配'
  return action.replace(processWords, '').trim().slice(0, 10) || '执行步骤'
}

function TaskBlock({ task, dishName, tone, selected, windowSize, planEnd, targetTime, onSelect, risk }: {
  task: DashboardTask; dishName: string; tone: TimelineResource['tone']; selected: boolean; windowSize: number; planEnd: number; targetTime?: string; onSelect: () => void; risk: boolean
}) {
  const [open, setOpen] = useState(false)
  const { refs, floatingStyles, context } = useFloating({ open, onOpenChange: setOpen, placement: 'top', whileElementsMounted: autoUpdate, middleware: [offset(10), flip({ padding: 12 }), shift({ padding: 12 })] })
  const hover = useHover(context, { move: false, delay: { open: 120, close: 80 } })
  const focus = useFocus(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'tooltip' })
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role])
  const start = clockAt(task.start_offset_sec, targetTime, planEnd)
  const end = clockAt(task.end_offset_sec, targetTime, planEnd)
  const resources = formatResources(task.assigned_resources)
  const kind = taskKind(task)
  const aria = `${dishName}，${task.action}，${statusLabel[task.status]}，${start}至${end}，使用${resources}`
  return <>
    <button
      ref={refs.setReference}
      type="button"
      aria-label={aria}
      title={`${task.action} · ${statusLabel[task.status]} · ${start}–${end}`}
      className={`task-bar ${tone} kind-${kind} ${task.status.toLowerCase()} ${task.locked ? 'locked' : ''} ${selected ? 'selected' : ''} ${risk ? 'buffer-risk' : ''}`}
      style={{ left: `${task.start_offset_sec / windowSize * 100}%`, width: `${Math.max((task.end_offset_sec - task.start_offset_sec) / windowSize * 100, 1.15)}%` }}
      onClick={onSelect}
      {...getReferenceProps()}
    >
      <b>{compactAction(task.action, kind)}</b><small>{statusLabel[task.status]} · {formatDuration(task.end_offset_sec - task.start_offset_sec)}</small>{risk && <i className="buffer-warning" aria-label="缓冲不足">!</i>}
    </button>
    {open && <FloatingPortal><div ref={refs.setFloating} style={floatingStyles} className="timeline-tooltip" {...getFloatingProps()}>
      <div className="tooltip-heading"><span>{dishName}</span><em className={`${task.status.toLowerCase()} kind-${kind}`}>{statusLabel[task.status]}</em></div>
      <strong>{task.action}</strong>
      <dl><div><dt>安排时间</dt><dd>{start}–{end} · {formatDuration(task.end_offset_sec - task.start_offset_sec)}</dd></div><div><dt>需要使用</dt><dd>{resources || '无人占用'}</dd></div><div><dt>任务类型</dt><dd>{kind === 'manual' ? '人工参与' : kind === 'automatic' ? '设备执行' : kind === 'waiting' ? '等待 / 静置' : '空闲时间'}</dd></div></dl>
      {risk && <p className="tooltip-warning">前后步骤间隔不足 5 分钟，存在延迟传导风险</p>}
      <p>{kind === 'manual' ? '这一步需要你参与操作' : kind === 'automatic' ? '这一步由设备自动执行' : kind === 'waiting' ? '这段时间无需持续操作' : '这段时间不占用设备和人力'}</p>
    </div></FloatingPortal>}
  </>
}

function ResourceBlock({ task, dishName, windowSize, resource, targetTime, planEnd, onSelect }: { task: DashboardTask; dishName: string; windowSize: number; resource: TimelineResource; targetTime?: string; planEnd: number; onSelect: () => void }) {
  const start = clockAt(task.start_offset_sec, targetTime, planEnd)
  const end = clockAt(task.end_offset_sec, targetTime, planEnd)
  return <button type="button" className={`resource-task ${resource.tone} ${task.status.toLowerCase()}`} title={`${task.action} · ${start}–${end}`} onClick={onSelect} style={{ left: `${task.start_offset_sec / windowSize * 100}%`, width: `${Math.max((task.end_offset_sec - task.start_offset_sec) / windowSize * 100, 1.15)}%` }}><span>{dishName}</span></button>
}

export function Timeline({ tasks, resources, selectedId, resourceFilter, targetTime, onSelect }: Props) {
  const [collapsedDishes, setCollapsedDishes] = useState<Set<string>>(new Set())
  const filteredTasks = useMemo(() => resourceFilter === 'all' ? tasks : tasks.filter(task => task.assigned_resources.includes(resourceFilter)), [resourceFilter, tasks])
  const planEnd = useMemo(() => Math.max(0, ...tasks.map(task => task.end_offset_sec)), [tasks])
  const windowSize = Math.max(MIN_WINDOW, Math.ceil(planEnd / WINDOW_UNIT) * WINDOW_UNIT)
  const tickStep = TICK_STEPS.find(step => windowSize / step <= MAX_TICKS) ?? TICK_STEPS[TICK_STEPS.length - 1]
  const ticks = Array.from({ length: Math.floor(windowSize / tickStep) + 1 }, (_, index) => index * tickStep)
  const resourceTone = useMemo(() => new Map(resources.map(resource => [resource.id, resource.tone])), [resources])
  const lanes = useMemo<DishLane[]>(() => {
    const groups = new Map<string, DashboardTask[]>()
    filteredTasks.forEach(task => groups.set(task.dish_id, [...(groups.get(task.dish_id) ?? []), task]))
    return [...groups.entries()]
      .map(([id, laneTasks], index) => ({ id, label: friendlyDishName(id, laneTasks, index), tasks: laneTasks, subrows: packSubrows(laneTasks) }))
      .sort((a, b) => Math.min(...a.tasks.map(task => task.start_offset_sec)) - Math.min(...b.tasks.map(task => task.start_offset_sec)))
  }, [filteredTasks])
  const riskyTaskIds = useMemo(() => new Set(lanes.flatMap(lane => {
    const sorted = [...lane.tasks].sort((a, b) => a.start_offset_sec - b.start_offset_sec)
    return sorted.slice(1).filter((task, index) => task.start_offset_sec - sorted[index].end_offset_sec > 0 && task.start_offset_sec - sorted[index].end_offset_sec < 300).map(task => task.task_id)
  })), [lanes])
  const resourceRows = useMemo(() => resources.map(resource => ({ resource, tasks: filteredTasks.filter(task => task.assigned_resources.includes(resource.id)) })).filter(row => row.tasks.length), [filteredTasks, resources])
  const activeTask = tasks.find(task => task.status === 'RUNNING')
  const completedEnd = Math.max(0, ...tasks.filter(task => task.status === 'COMPLETED').map(task => task.end_offset_sec))
  const nowOffset = Math.min(activeTask ? activeTask.start_offset_sec + Math.min((activeTask.end_offset_sec - activeTask.start_offset_sec) * .35, 120) : completedEnd, windowSize)
  const prepEnd = Math.max(0, ...tasks.filter(task => preparationWords.test(task.action)).map(task => task.end_offset_sec))
  const milestoneOffsets = [{ offset: prepEnd, label: '备料完成' }, { offset: planEnd, label: '预计出餐' }].filter((milestone, index, all) => milestone.offset > 0 && all.findIndex(item => item.offset === milestone.offset) === index)

  return <section className="timeline-card">
    <div className="timeline-title"><div><p className="eyebrow">多菜并行甘特图</p><h2>按菜品看步骤，按资源查冲突</h2><p className="timeline-caption">任务条显示状态和时长；悬停查看完整工序，点击打开步骤详情。</p></div><div className="timeline-status"><span className="live-pill"><i />计划进行中</span></div></div>
    <div className="timeline-legend"><span><i className="legend-dot pending" />待执行</span><span><i className="legend-dot scheduled" />已排期</span><span><i className="legend-dot running" />执行中</span><span><i className="legend-dot delayed" />已延迟</span><span><i className="legend-dot completed" />已完成</span><span><i className="legend-dot exception" />异常</span><span><i className="legend-dot waiting" />等待 / 静置</span><span><i className="legend-dot buffer" />缓冲不足</span></div>
    {!lanes.length ? <div className="timeline-empty"><strong>暂无可展示的排程</strong><span>当前筛选条件下没有任务，请切换设备或返回排程配置。</span></div> : <div className="timeline-scroll">
      <div className="timeline-grid-header"><div className="dish-lane-label header-label">菜品线程</div><div className="axis" aria-label="时间刻度">{ticks.map(tick => <span key={tick} style={{ left: `${tick / windowSize * 100}%` }}>{clockAt(tick, targetTime, planEnd)}</span>)}{milestoneOffsets.map(milestone => <i className="milestone-line" key={milestone.label} style={{ left: `${milestone.offset / windowSize * 100}%` }}><b>{milestone.label}</b></i>)}{nowOffset > 0 && <i className="now-line" style={{ left: `${nowOffset / windowSize * 100}%` }}><b>当前</b></i>}</div></div>
      {lanes.map(lane => { const collapsed = collapsedDishes.has(lane.id); return <div className={`timeline-row dish-lane ${collapsed ? 'collapsed' : ''}`} key={lane.id} style={{ '--lane-height': `${collapsed ? 58 : 64 + (lane.subrows.length - 1) * 50}px` } as CSSProperties}>
        <button type="button" className="dish-lane-label" aria-expanded={!collapsed} onClick={() => setCollapsedDishes(current => { const next = new Set(current); if (next.has(lane.id)) next.delete(lane.id); else next.add(lane.id); return next })}><span className="dish-thread-dot" /><b><span className="collapse-icon">{collapsed ? '＋' : '−'}</span>{lane.label}</b><small>{lane.tasks.length} 个步骤 · {collapsed ? '点击展开' : '点击收起'}</small></button>
        <div className="track">{ticks.slice(1).map(tick => <i className="grid-line" key={tick} style={{ left: `${tick / windowSize * 100}%` }} />)}{milestoneOffsets.map(milestone => <i className="milestone-line" key={milestone.label} style={{ left: `${milestone.offset / windowSize * 100}%` }} />)}{nowOffset > 0 && <i className="now-line" style={{ left: `${nowOffset / windowSize * 100}%` }} />}
          {!collapsed && lane.subrows.flatMap((row, rowIndex) => row.map(task => <div className="task-slot" key={task.task_id} style={{ top: `${10 + rowIndex * 50}px` }}><TaskBlock task={task} dishName={lane.label} tone={resourceTone.get(task.assigned_resources.find(id => !id.startsWith('operator_')) ?? task.assigned_resources[0]) ?? 'gold'} selected={selectedId === task.task_id} windowSize={windowSize} planEnd={planEnd} targetTime={targetTime} risk={riskyTaskIds.has(task.task_id)} onSelect={() => onSelect(task)} /></div>))}
        </div>
      </div>})}
      {resourceRows.length > 0 && <><div className="resource-section-title"><strong>资源占用</strong><span>检查同一时刻的蒸箱、烤箱、灶具和人手是否冲突</span></div><div className="resource-grid"><div className="resource-label header-label">设备 / 人力</div><div className="resource-axis">{ticks.map(tick => <i className="grid-line" key={tick} style={{ left: `${tick / windowSize * 100}%` }} />)}</div>{resourceRows.map(({ resource, tasks: rowTasks }) => <div className="resource-row" key={resource.id}><div className="resource-label"><span className={`resource-dot ${resource.tone}`} /><b>{resource.label}</b></div><div className="resource-track">{ticks.slice(1).map(tick => <i className="grid-line" key={tick} style={{ left: `${tick / windowSize * 100}%` }} />)}{rowTasks.map(task => <ResourceBlock key={`${resource.id}-${task.task_id}`} task={task} dishName={friendlyDishName(task.dish_id, rowTasks.filter(item => item.dish_id === task.dish_id), 0)} resource={resource} windowSize={windowSize} targetTime={targetTime} planEnd={planEnd} onSelect={() => onSelect(task)} />)}</div></div>)}</div></>}
    </div>}
  </section>
}
