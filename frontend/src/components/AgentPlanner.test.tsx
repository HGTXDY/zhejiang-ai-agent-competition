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
    step="recipes"
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

it('answers a catalog question without turning it into a missing-fields form', async () => {
  mockedInterpret.mockResolvedValueOnce({
    intent: 'answer_question',
    reply: '菜谱库里有鸡翅包饭、苹果芒果派和低温牛排等菜，你偏爱哪一类？',
    draft: { recipes: [], target_time: null, operator_count: null, devices: {} },
    missing_fields: ['recipes', 'target_time', 'operator_count'],
    unmatched_recipe_names: [],
    ready_to_confirm: false,
    tool_trace: [],
  })
  start()

  send('菜谱里有什么菜？')

  await screen.findByText('菜谱库里有鸡翅包饭、苹果芒果派和低温牛排等菜，你偏爱哪一类？')
  expect(screen.getByText('先说说你的做饭需求')).toBeInTheDocument()
  expect(screen.queryByText('还需要补充信息，请直接在左侧继续回答。')).not.toBeInTheDocument()
})

it('shows an animated thinking status while the model request is pending', async () => {
  let resolveRequest!: (value: AgentPlanResponse) => void
  mockedInterpret.mockImplementationOnce(() => new Promise(resolve => { resolveRequest = resolve }))
  start()

  send('今晚六点半开饭')

  expect(screen.getByRole('status', { name: '灶序正在思考' })).toBeInTheDocument()
  expect(screen.getByText('正在理解你的需求')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /理解中/ })).toBeDisabled()

  resolveRequest(validPlan)
  await screen.findByText('还需要补充开饭时间。')
  expect(screen.queryByRole('status', { name: '灶序正在思考' })).not.toBeInTheDocument()
})

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

it('restores the chat history after being remounted', async () => {
  mockedInterpret.mockResolvedValueOnce({ ...validPlan, reply: '收到，已记录清蒸鱼。' })
  const props = { step: 'recipes' as const, catalog: [], loading: false, modelReady: true, offlineDemo: false, onOpenSettings: vi.fn(), onBack: vi.fn(), onConfirm: vi.fn() }
  const first = render(<AgentPlanner {...props} />)
  send('我要做清蒸鱼')
  await screen.findByText('收到，已记录清蒸鱼。')
  first.unmount()

  render(<AgentPlanner {...props} />)
  expect(screen.getByText('我要做清蒸鱼')).toBeInTheDocument()
  expect(screen.getByText('收到，已记录清蒸鱼。')).toBeInTheDocument()
})
