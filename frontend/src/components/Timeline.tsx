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

const MIN_WINDOW = 900
const STEP = 300
const statusLabel: Record<DashboardTask['status'], string> = { PENDING: '待执行', LOCKED: '已锁定', RUNNING: '执行中', DELAYED: '已延迟', COMPLETED: '已完成', EXCEPTION: '异常', CANCELLED: '已取消' }
const knownDishLabels: Record<string, string> = {
  braised_ribs: '红烧排骨', steamed_fish: '清蒸鲈鱼', baked_wings: '烤鸡翅', garlic_broccoli: '蒜蓉西兰花', mapo_tofu: '麻婆豆腐',
}
const processWords = /(预处理|备料|改刀|切配|装盘|腌制|焯水|烹制|烹饪|蒸制|清蒸|烘烤|烤制|翻炒|炒制|炖煮|收汁|完成)$/

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

function TaskBlock({ task, dishName, tone, selected, windowSize, planEnd, targetTime, onSelect }: {
  task: DashboardTask; dishName: string; tone: TimelineResource['tone']; selected: boolean; windowSize: number; planEnd: number; targetTime?: string; onSelect: () => void
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
  const aria = `${dishName}，${task.action}，${statusLabel[task.status]}，${start}至${end}，使用${resources}`
  return <>
    <button
      ref={refs.setReference}
      type="button"
      aria-label={aria}
      className={`task-bar ${tone} ${task.status.toLowerCase()} ${task.locked ? 'locked' : ''} ${selected ? 'selected' : ''}`}
      style={{ left: `${task.start_offset_sec / windowSize * 100}%`, width: `${Math.max((task.end_offset_sec - task.start_offset_sec) / windowSize * 100, 2.4)}%` }}
      onClick={onSelect}
      {...getReferenceProps()}
    >
      <b>{task.action}</b><small>{start}–{end}</small>
    </button>
    {open && <FloatingPortal><div ref={refs.setFloating} style={floatingStyles} className="timeline-tooltip" {...getFloatingProps()}>
      <div className="tooltip-heading"><span>{dishName}</span><em className={task.status.toLowerCase()}>{statusLabel[task.status]}</em></div>
      <strong>{task.action}</strong>
      <dl><div><dt>安排时间</dt><dd>{start}–{end} · {formatDuration(task.end_offset_sec - task.start_offset_sec)}</dd></div><div><dt>需要使用</dt><dd>{resources}</dd></div></dl>
      <p>{task.assigned_resources.some(id => id.startsWith('operator_')) ? '这一步需要你参与操作' : '这一步由设备自动执行'}</p>
    </div></FloatingPortal>}
  </>
}

export function Timeline({ tasks, resources, selectedId, resourceFilter, targetTime, onSelect }: Props) {
  const filteredTasks = useMemo(() => resourceFilter === 'all' ? tasks : tasks.filter(task => task.assigned_resources.includes(resourceFilter)), [resourceFilter, tasks])
  const planEnd = useMemo(() => Math.max(0, ...tasks.map(task => task.end_offset_sec)), [tasks])
  const windowSize = Math.max(MIN_WINDOW, Math.ceil(planEnd / STEP) * STEP)
  const ticks = Array.from({ length: Math.floor(windowSize / STEP) + 1 }, (_, index) => index * STEP)
  const resourceTone = useMemo(() => new Map(resources.map(resource => [resource.id, resource.tone])), [resources])
  const lanes = useMemo<DishLane[]>(() => {
    const groups = new Map<string, DashboardTask[]>()
    filteredTasks.forEach(task => groups.set(task.dish_id, [...(groups.get(task.dish_id) ?? []), task]))
    return [...groups.entries()]
      .map(([id, laneTasks], index) => ({ id, label: friendlyDishName(id, laneTasks, index), tasks: laneTasks, subrows: packSubrows(laneTasks) }))
      .sort((a, b) => Math.min(...a.tasks.map(task => task.start_offset_sec)) - Math.min(...b.tasks.map(task => task.start_offset_sec)))
  }, [filteredTasks])
  const activeTask = tasks.find(task => task.status === 'RUNNING')
  const completedEnd = Math.max(0, ...tasks.filter(task => task.status === 'COMPLETED').map(task => task.end_offset_sec))
  const nowOffset = Math.min(activeTask ? activeTask.start_offset_sec + Math.min((activeTask.end_offset_sec - activeTask.start_offset_sec) * .35, 120) : completedEnd, windowSize)

  return <section className="timeline-card">
    <div className="timeline-title"><div><p className="eyebrow">多菜并行时间轴</p><h2>每道菜一条线，同时做什么一眼看清</h2><p className="timeline-caption">悬停查看菜品、时间和设备；点击可打开步骤详情。</p></div><div className="timeline-status"><span className="live-pill"><i />计划进行中</span></div></div>
    <div className="timeline-legend"><span><i className="legend-dot manual" />人工参与</span><span><i className="legend-dot automatic" />设备执行</span><span><i className="legend-dot waiting" />待执行</span><span><i className="legend-dot issue" />异常或延迟</span></div>
    {!lanes.length ? <div className="timeline-empty"><strong>暂无可展示的排程</strong><span>当前筛选条件下没有任务，请切换设备或返回排程配置。</span></div> : <div className="timeline-scroll">
      <div className="timeline-grid-header"><div className="dish-lane-label header-label">菜品线程</div><div className="axis" aria-label="时间刻度">{ticks.map(tick => <span key={tick} style={{ left: `${tick / windowSize * 100}%` }}>{clockAt(tick, targetTime, planEnd)}</span>)}{nowOffset > 0 && <i className="now-line" style={{ left: `${nowOffset / windowSize * 100}%` }}><b>当前</b></i>}</div></div>
      {lanes.map(lane => <div className="timeline-row dish-lane" key={lane.id} style={{ '--lane-height': `${64 + (lane.subrows.length - 1) * 50}px` } as CSSProperties}>
        <div className="dish-lane-label"><span className="dish-thread-dot" /><b>{lane.label}</b><small>{lane.tasks.length} 个步骤</small></div>
        <div className="track">{ticks.slice(1).map(tick => <i className="grid-line" key={tick} style={{ left: `${tick / windowSize * 100}%` }} />)}{nowOffset > 0 && <i className="now-line" style={{ left: `${nowOffset / windowSize * 100}%` }} />}
          {lane.subrows.flatMap((row, rowIndex) => row.map(task => <div className="task-slot" key={task.task_id} style={{ top: `${10 + rowIndex * 50}px` }}><TaskBlock task={task} dishName={lane.label} tone={resourceTone.get(task.assigned_resources.find(id => !id.startsWith('operator_')) ?? task.assigned_resources[0]) ?? 'gold'} selected={selectedId === task.task_id} windowSize={windowSize} planEnd={planEnd} targetTime={targetTime} onSelect={() => onSelect(task)} /></div>))}
        </div>
      </div>)}
    </div>}
  </section>
}
