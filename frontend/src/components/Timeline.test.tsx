import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Timeline } from './Timeline'
import type { DashboardTask, TimelineResource } from '../types/contracts'

const resources: TimelineResource[] = [
  { id: 'operator_1', label: '操作员 · 主厨', tone: 'gold' },
  { id: 'stove_1', label: '灶具 · 01', tone: 'cyan' },
  { id: 'steamer_1', label: '蒸箱 · 01', tone: 'violet' },
]

const tasks: DashboardTask[] = [
  { task_id: 't1', dish_id: 'd1', dish_name: '红烧排骨', action: '排骨备料', start_offset_sec: 0, end_offset_sec: 300, assigned_resources: ['operator_1'], status: 'COMPLETED', locked: true, notification_points: [] },
  { task_id: 't2', dish_id: 'd1', dish_name: '红烧排骨', action: '排骨焯水', start_offset_sec: 300, end_offset_sec: 900, assigned_resources: ['stove_1', 'operator_1'], status: 'RUNNING', locked: true, notification_points: [] },
  { task_id: 't3', dish_id: 'd2', dish_name: '清蒸鲈鱼', action: '清蒸鲈鱼', start_offset_sec: 300, end_offset_sec: 900, assigned_resources: ['steamer_1'], status: 'PENDING', locked: false, notification_points: [] },
]

const renderTimeline = (overrides: Partial<React.ComponentProps<typeof Timeline>> = {}) => render(<Timeline tasks={tasks} resources={resources} selectedId={null} resourceFilter="all" targetTime="12:30" onSelect={() => {}} {...overrides} />)

describe('Timeline', () => {
  it('renders one dish swimlane with multiple steps instead of duplicating tasks by resource', () => {
    const { container } = renderTimeline()
    expect(container.querySelectorAll('.dish-lane')).toHaveLength(2)
    expect(screen.getAllByText('红烧排骨').length).toBeGreaterThan(0)
    expect(screen.getByText(/2 个步骤/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /排骨焯水/ })).toHaveLength(1)
  })

  it('shows explicit clock labels derived from the target meal time', () => {
    renderTimeline()
    expect(screen.getByText('12:15')).toBeInTheDocument()
    expect(screen.getByText('12:30')).toBeInTheDocument()
  })

  it('uses readable adaptive landmarks instead of labeling every minute on long plans', () => {
    const longTasks = [{ ...tasks[0], end_offset_sec: 4 * 60 * 60 }]
    const { container } = renderTimeline({ tasks: longTasks })
    expect(container.querySelectorAll('.axis > span').length).toBeLessThanOrEqual(5)
    expect(screen.getByText('08:30')).toBeInTheDocument()
  })

  it('renders an empty state when there are no tasks', () => {
    renderTimeline({ tasks: [] })
    expect(screen.getByText('暂无可展示的排程')).toBeInTheDocument()
  })

  it('filters task blocks by resource while keeping dish swimlanes', () => {
    renderTimeline({ resourceFilter: 'stove_1' })
    expect(screen.getByRole('button', { name: /排骨焯水/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /清蒸鲈鱼/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /排骨备料/ })).not.toBeInTheDocument()
  })

  it('reports the clicked task through onSelect', () => {
    const onSelect = vi.fn()
    renderTimeline({ onSelect })
    fireEvent.click(screen.getByRole('button', { name: /排骨焯水/ }))
    expect(onSelect).toHaveBeenCalledWith(tasks[1])
  })

  it('shows friendly dish, time, duration, equipment and status on hover and focus', async () => {
    renderTimeline()
    const block = screen.getByRole('button', { name: /排骨焯水.*执行中.*12:20至12:30.*灶具 1、操作台 1/ })
    fireEvent.mouseEnter(block)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('红烧排骨')
    expect(screen.getByRole('tooltip')).toHaveTextContent('10 分钟')
    expect(screen.getByRole('tooltip')).toHaveTextContent('灶具 1、操作台 1')
    fireEvent.mouseLeave(block)
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
    fireEvent.focus(block)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('这一步需要你参与操作')
  })
})
