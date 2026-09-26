import type { ScheduleTask, TimelineResource } from '../types/contracts'

interface Props { tasks: ScheduleTask[]; resources: TimelineResource[]; selectedId: string | null; onSelect: (task: ScheduleTask) => void }
const WINDOW = 2700
const format = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`

export function Timeline({ tasks, resources, selectedId, onSelect }: Props) {
  const ticks = Array.from({ length: 10 }, (_, index) => index * 300)
  return <section className="timeline-card">
    <div className="timeline-title"><div><p className="eyebrow">LIVE SCHEDULE</p><h2>资源轨道 · 执行排程</h2></div><span className="live-pill"><i />实时模拟</span></div>
    <div className="timeline-scroll">
      <div className="timeline-grid-header"><div className="resource-label">资源</div><div className="axis">{ticks.map(tick => <span key={tick} style={{ left: `${tick / WINDOW * 100}%` }}>{format(tick)}</span>)}</div></div>
      {resources.map(resource => <div className="timeline-row" key={resource.id}>
        <div className="resource-label"><b>{resource.label.split(' · ')[0]}</b><small>{resource.label.split(' · ')[1]}</small></div>
        <div className="track">{ticks.slice(1).map(tick => <i className="grid-line" key={tick} style={{ left: `${tick / WINDOW * 100}%` }} />)}
          {tasks.filter(task => task.assigned_resources.includes(resource.id)).map(task => <button className={`task-bar ${resource.tone} ${task.status.toLowerCase()} ${selectedId === task.task_id ? 'selected' : ''}`} key={`${resource.id}-${task.task_id}`} style={{ left: `${task.start_offset_sec / WINDOW * 100}%`, width: `${Math.max((task.end_offset_sec - task.start_offset_sec) / WINDOW * 100, 3)}%` }} onClick={() => onSelect(task)} title={task.action}><b>{task.action}</b><small>{format(task.start_offset_sec)} — {format(task.end_offset_sec)}</small></button>)}
        </div>
      </div>)}
    </div>
  </section>
}
