import { useMemo, useState } from 'react'
import { MetricCard } from './components/MetricCard'
import { Timeline } from './components/Timeline'
import { initialSchedule, resources } from './mock/schedule'
import type { ScheduleTask } from './types/contracts'
import './styles.css'

const statusLabel: Record<ScheduleTask['status'], string> = { PENDING: '待执行', RUNNING: '执行中', DELAYED: '已延迟', COMPLETED: '已完成', EXCEPTION: '异常' }

export default function App() {
  const [tasks, setTasks] = useState(initialSchedule.tasks)
  const [selectedId, setSelectedId] = useState<string | null>('ribs_blanch')
  const [toast, setToast] = useState('排程已生成，等待执行事件')
  const selected = tasks.find(task => task.task_id === selectedId) ?? null
  const completed = tasks.filter(task => task.status === 'COMPLETED').length
  const progress = Math.round(completed / tasks.length * 100)
  const metrics = useMemo(() => ({ ...initialSchedule.metrics, makespan_sec: Math.max(...tasks.map(task => task.end_offset_sec)) }), [tasks])

  function updateSelected(next: 'COMPLETED' | 'DELAYED' | 'EXCEPTION') {
    if (!selected || selected.locked) { setToast('该任务已锁定，不能直接修改'); return }
    setTasks(current => current.map(task => task.task_id === selected.task_id ? { ...task, status: next } : task))
    setToast(`${selected.action}：已上报${statusLabel[next]}事件`)
  }

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark">灶</div><div><strong>灶序</strong><span>COOKFLOW AGENT</span></div></div><div className="session"><span className="status-dot" />厨房 A · 午餐批次 <b>12:30</b><button className="avatar">H</button></div></header>
    <div className="content">
      <section className="hero"><div><p className="eyebrow">智能烹饪调度中心 / 2026.09.26</p><h1>让每一道菜，<em>刚好同时出锅。</em></h1><p className="subtitle">四道菜 · 单人操作 · 自动调度中</p></div><div className="hero-actions"><button className="secondary" onClick={() => setToast('已打开完整排程快照')}>查看快照</button><button className="primary" onClick={() => setToast('已创建动态重排请求')}>＋ 临时加菜</button></div></section>
      <section className="metric-grid"><MetricCard label="当前进度" value={`${progress}%`} hint={`${completed} / ${tasks.length} 个任务完成`} /><MetricCard label="预计完成" value="12:41" hint="较目标晚 01:20" accent="cyan" /><MetricCard label="出锅时间差" value={`${Math.floor(metrics.finish_spread_sec / 60)}′`} hint="目标 ≤ 5′" accent="violet" /><MetricCard label="约束状态" value="0 冲突" hint="设备 · 依赖 · 人工" accent="green" /></section>
      <Timeline tasks={tasks} resources={resources} selectedId={selectedId} onSelect={task => setSelectedId(task.task_id)} />
      <section className="lower-grid"><div className="task-panel"><div className="panel-heading"><div><p className="eyebrow">TASK QUEUE</p><h2>任务队列</h2></div><span>{tasks.length} tasks</span></div><div className="task-list">{tasks.map(task => <button className={`task-row ${selectedId === task.task_id ? 'active' : ''}`} key={task.task_id} onClick={() => setSelectedId(task.task_id)}><span className={`task-icon ${task.status.toLowerCase()}`}>{task.status === 'COMPLETED' ? '✓' : task.status === 'RUNNING' ? '◉' : '·'}</span><span className="task-main"><b>{task.action}</b><small>{task.task_id} · {task.assigned_resources.join(' / ') || '人工操作'}</small></span><span className={`badge ${task.status.toLowerCase()}`}>{statusLabel[task.status]}</span></button>)}</div></div>
        <aside className="detail-panel"><p className="eyebrow">SELECTED TASK</p>{selected ? <><h2>{selected.action}</h2><p className="detail-id">{selected.task_id}</p><div className="detail-row"><span>执行窗口</span><b>{Math.floor(selected.start_offset_sec / 60)}:{String(selected.start_offset_sec % 60).padStart(2, '0')} — {Math.floor(selected.end_offset_sec / 60)}:{String(selected.end_offset_sec % 60).padStart(2, '0')}</b></div><div className="detail-row"><span>资源</span><b>{selected.assigned_resources.join(' · ') || '主厨操作'}</b></div><div className="event-actions"><button onClick={() => updateSelected('COMPLETED')}>完成任务</button><button onClick={() => updateSelected('DELAYED')}>上报延迟</button><button className="danger" onClick={() => updateSelected('EXCEPTION')}>设备异常</button></div></> : <p>选择一个任务查看详情</p>}</aside></section>
      <div className="toast"><span className="toast-dot" />{toast}<span className="toast-time">刚刚</span></div>
    </div>
  </main>
}
