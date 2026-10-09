import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExecutionDashboard from './ExecutionDashboard'
import { setMockFault } from '../mock/api'
import { recipeCatalog } from '../mock/recipes'

beforeEach(() => setMockFault('none'))
afterEach(() => setMockFault('none'))

/** Select the unlocked PENDING task so the action buttons are available. */
function selectFishSteam() {
  fireEvent.click(screen.getAllByRole('button', { name: /清蒸鲈鱼.*待执行/ })[0])
}

describe('ExecutionDashboard', () => {
  it('renders the derived metrics and the task queue', () => {
    render(<ExecutionDashboard />)
    expect(screen.getByText('完成进度')).toBeInTheDocument()
    expect(screen.getByText('节省时间')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /清蒸鲈鱼/ })[0]).toBeInTheDocument()
  })

  it('disables restoring the initial schedule after execution changes', async () => {
    render(<ExecutionDashboard />)
    selectFishSteam()
    const restore = screen.getByRole('button', { name: '恢复计划' })
    expect(restore).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
    await waitFor(() =>
      expect(restore).toHaveAttribute(
        'title',
        '执行状态已变化，不能回滚到最初计划',
      ),
    )
    expect(restore).toBeDisabled()
  })

  it('walks a task from PENDING through RUNNING, revealing one step, then 结束任务 advances', async () => {
    render(<ExecutionDashboard />)
    selectFishSteam()
    expect(screen.getByRole('button', { name: '开始执行' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /下一步/ })).toBeInTheDocument())

    // The mock completion produces one reminder, so a single 下一步 drains the
    // reveal and surfaces 结束任务.
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /结束任务/ })).toBeInTheDocument())

    // Finalising locks the step and advances selection to the next actionable task.
    fireEvent.click(screen.getByRole('button', { name: /结束任务/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: '开始执行' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /结束任务/ })).not.toBeInTheDocument()
  })

  it('surfaces a distinct message for a 409 no-feasible-schedule failure', async () => {
    setMockFault('infeasible')
    const { container } = render(<ExecutionDashboard />)
    selectFishSteam()
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
    await waitFor(() => expect(container.querySelector('.error-banner')).toHaveTextContent('无可行排程'))
  })

  it('surfaces a distinct message for a 504 solver timeout', async () => {
    setMockFault('timeout')
    const { container } = render(<ExecutionDashboard />)
    selectFishSteam()
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
    await waitFor(() => expect(container.querySelector('.error-banner')).toHaveTextContent('求解超时'))
  })

  it('surfaces a distinct message for a network failure', async () => {
    setMockFault('network')
    const { container } = render(<ExecutionDashboard />)
    selectFishSteam()
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
    await waitFor(() => expect(container.querySelector('.error-banner')).toHaveTextContent('网络连接失败'))
  })


  it('opens a dish picker and adds the selected dish instead of a fixed dish', async () => {
    render(<ExecutionDashboard />)
    fireEvent.click(screen.getByRole('button', { name: /临时加菜/ }))
    expect(screen.getByRole('dialog', { name: '临时加菜' })).toBeInTheDocument()
    const candidate = recipeCatalog.find(recipe => recipe.name === '麻辣对虾')!
    fireEvent.click(within(screen.getByRole('dialog', { name: '临时加菜' })).getAllByRole('button', { name: new RegExp(candidate.name) })[0])
    fireEvent.click(screen.getByRole('button', { name: '加入排程' }))
    await waitFor(() => expect(screen.getAllByText(`已加入临时菜：${candidate.name}`).length).toBeGreaterThan(0))
    expect(screen.getAllByText(new RegExp(candidate.name)).length).toBeGreaterThan(0)
    expect(screen.queryByText('已加入临时菜：麻婆豆腐')).not.toBeInTheDocument()
  })

  it('can return to the planner from the execution view', () => {
    const onBackToPlanner = vi.fn()
    render(<ExecutionDashboard onBackToPlanner={onBackToPlanner} />)
    fireEvent.click(screen.getByRole('button', { name: /返回计划/ }))
    expect(onBackToPlanner).toHaveBeenCalledOnce()
  })

  it('offers a fault drill control in mock mode', () => {
    render(<ExecutionDashboard />)
    const select = screen.getByLabelText('故障演练')
    expect(select).toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'timeout' } })
    expect(select).toHaveValue('timeout')
  })

  it('opens the execution chat from the icon button and adds a device from a command', async () => {
    render(<ExecutionDashboard />)
    fireEvent.click(screen.getByRole('button', { name: '现场改动' }))
    expect(screen.getByRole('dialog', { name: '现场改动' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('输入执行指令'), { target: { value: '现在多一个灶台' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(screen.getAllByText('已新增设备：灶具').length).toBeGreaterThan(0))
  })

  it('opens the gantt chart in a modal from the icon button', () => {
    render(<ExecutionDashboard />)
    fireEvent.click(screen.getByRole('button', { name: '甘特图' }))
    expect(screen.getByRole('dialog', { name: '甘特图' })).toBeInTheDocument()
    expect(screen.getByText('按菜品看步骤，按资源查冲突')).toBeInTheDocument()
  })
})
