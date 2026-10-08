import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentPlanner from './AgentPlanner'
import { interpretAgentMessage } from '../api/agent'
import { ProductApiError } from '../api/product'
import type { AgentPlanResponse } from '../types/product'

vi.mock('../api/agent', () => ({
  interpretAgentMessage: vi.fn(),
  draftToKitchen: vi.fn(),
}))

const mockedInterpret = vi.mocked(interpretAgentMessage)
const validPlan = {
  reply: '还需要补充开饭时间。',
  draft: {
    recipes: [{ recipe_id: 'r1', name: '清蒸鱼' }],
    target_time: null,
    operator_count: null,
    devices: { stove_count: 1, steamer_count: null, oven_count: null },
  },
  missing_fields: ['target_time'],
  ready_to_confirm: false,
  tool_trace: [],
} as unknown as AgentPlanResponse

function start() {
  render(<AgentPlanner
    catalog={[]}
    loading={false}
    modelReady={true}
    offlineDemo={false}
    onOpenSettings={vi.fn()}
    onBack={vi.fn()}
    onConfirm={vi.fn()}
  />)
}

function send(message: string) {
  fireEvent.change(screen.getByRole('textbox', { name: '告诉智能助手你的做饭需求' }), {
    target: { value: message },
  })
  fireEvent.click(screen.getByRole('button', { name: /发送/ }))
}

beforeEach(() => { mockedInterpret.mockReset() })
afterEach(cleanup)

it('keeps the last valid draft and explains a temporary model failure', async () => {
  mockedInterpret.mockResolvedValueOnce(validPlan)
    .mockRejectedValueOnce(new ProductApiError('模型服务连接意外中断，请稍后重试', 502, 'HTTP_ERROR'))
    .mockResolvedValueOnce({ ...validPlan, reply: '收到新的开饭时间。' })
  start()
  send('我要做清蒸鱼')
  await screen.findByText('还需要补充开饭时间。')
  expect(screen.getByText('清蒸鱼')).toBeInTheDocument()

  send('晚上六点半开饭')
  await screen.findByText(/模型服务连接意外中断/)
  expect(screen.getByText(/已保留之前确认的菜单和厨房条件/)).toBeInTheDocument()
  expect(screen.getByText('清蒸鱼')).toBeInTheDocument()

  send('晚上六点半开饭')
  await screen.findByText('收到新的开饭时间。')
  await waitFor(() => expect(mockedInterpret).toHaveBeenCalledTimes(3))
  expect(mockedInterpret.mock.calls[1][2]).toEqual(validPlan.draft)
  expect(mockedInterpret.mock.calls[2][2]).toEqual(validPlan.draft)
})
