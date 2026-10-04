import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Timeline } from './Timeline'
import type { DashboardTask, TimelineResource } from '../types/contracts'

const resources: TimelineResource[] = [
  { id: 'operator_1', label: '操作员 · 主厨', tone: 'gold' },
  { id: 'stove_1', label: '灶具 · 01', tone: 'cyan' },
  { id: 'steamer_1', label: '蒸箱 · 01', tone: 'violet' },
]

const tasks: DashboardTask[] = [
  { task_id: 't1', dish_id: 'd1', action: '排骨焯水', start_offset_sec: 0, end_offset_sec: 600, assigned_resources: ['stove_1'], status: 'RUNNING', locked: true, notification_points: [] },
  { task_id: 't2', dish_id: 'd2', action: '清蒸鲈鱼', start_offset_sec: 300, end_offset_sec: 900, assigned_resources: ['steamer_1'], status: 'PENDING', locked: false, notification_points: [] },
]

describe('Timeline', () => {
  it('renders a task bar with its action and status in the accessible label', () => {
    render(<Timeline tasks={tasks} resources={resources} selectedId={null} resourceFilter="all" onSelect={() => {}} />)
    expect(screen.getByRole('button', { name: /排骨焯水.*执行中/ })).toBeInTheDocument()
  })

  it('renders an empty state when there are no tasks', () => {
    render(<Timeline tasks={[]} resources={resources} selectedId={null} resourceFilter="all" onSelect={() => {}} />)
    expect(screen.getByText('暂无可展示的排程')).toBeInTheDocument()
  })

  it('filters tasks by the selected resource track', () => {
    render(<Timeline tasks={tasks} resources={resources} selectedId={null} resourceFilter="stove_1" onSelect={() => {}} />)
    expect(screen.getByRole('button', { name: /排骨焯水/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /清蒸鲈鱼/ })).not.toBeInTheDocument()
  })

  it('reports the clicked task through onSelect', () => {
    const onSelect = vi.fn()
    render(<Timeline tasks={tasks} resources={resources} selectedId={null} resourceFilter="all" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: /排骨焯水/ }))
    expect(onSelect).toHaveBeenCalledWith(tasks[0])
  })
})
