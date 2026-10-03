import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ExecutionDashboard from './ExecutionDashboard'
import { setMockFault } from '../mock/api'

beforeEach(() => setMockFault('none'))
afterEach(() => setMockFault('none'))

/** Select the unlocked PENDING task so the action buttons are available. */
function selectFishSteam() {
  fireEvent.click(screen.getByRole('button', { name: /fish_steam/ }))
}

describe('ExecutionDashboard', () => {
  it('renders the derived metrics and the task queue', () => {
    render(<ExecutionDashboard />)
    expect(screen.getByText('当前进度')).toBeInTheDocument()
    expect(screen.getByText('烹饪时间压缩')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /fish_steam/ })).toBeInTheDocument()
  })

  it('drives a task from PENDING through RUNNING to COMPLETED', async () => {
    render(<ExecutionDashboard />)
    selectFishSteam()
    expect(screen.getByRole('button', { name: '开始执行' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '完成任务' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '完成任务' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '完成任务' })).not.toBeInTheDocument())
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

  it('offers a fault drill control in mock mode', () => {
    render(<ExecutionDashboard />)
    const select = screen.getByLabelText('故障演练')
    expect(select).toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'timeout' } })
    expect(select).toHaveValue('timeout')
  })
})
