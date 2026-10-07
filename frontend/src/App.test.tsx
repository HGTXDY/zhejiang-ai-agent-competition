import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import responseExample from '../../contracts/v1/examples/schedule-response-v1.json'
import taskExample from '../../contracts/v1/examples/schedule-request-v1.json'
import { recipeCatalog } from './mock/recipes'

const ids = ['review_real_a', 'review_real_b', 'review_real_c']
const tasks = ids.map(id => ({ ...taskExample.tasks[0], task_id: `${id}_prepare`, dish_id: id, predecessors: [] }))
const schedule = { ...responseExample, tasks: tasks.map((task, index) => ({ task_id: task.task_id, dish_id: task.dish_id, start_offset_sec: index * task.duration_sec, end_offset_sec: (index + 1) * task.duration_sec, assigned_resources: ['operator_1'], status: 'PENDING', locked: false, notification_points: [] })) }
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

async function flow(names: string[]) {
  const manual = screen.queryByRole('button', { name: /手动精确配置/ })
  if (manual) fireEvent.click(manual)
  for (const name of names) fireEvent.click(await screen.findByRole('button', { name: new RegExp(name) }))
  fireEvent.click(screen.getByRole('button', { name: /下一步：配置厨房/ }))
  await screen.findByText('告诉我你的厨房现在有什么')
  fireEvent.click(screen.getByRole('button', { name: /下一步：解析确认/ }))
  await screen.findByText('确认菜谱解析结果')
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  fireEvent.click(screen.getByRole('button', { name: /生成初始排程/ }))
  await screen.findByText('接下来做什么')
}


it('opens the full manual recipe catalog when the first step is clicked from the mode chooser', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  const App = (await import('./App')).default
  render(<App />)
  await screen.findByText(/演示模式/)

  const steps = within(screen.getByRole('navigation', { name: '排程创建步骤' }))
  fireEvent.click(steps.getByRole('button', { name: /选择菜谱/ }))
  expect(await screen.findByText('选择今天要做的菜')).toBeInTheDocument()
  expect(screen.getAllByText((_, element) => element?.textContent?.includes(`已接入 ${recipeCatalog.length} 道官方菜谱`) ?? false).length).toBeGreaterThan(0)
  expect(screen.getByRole('button', { name: new RegExp(recipeCatalog[0].name) })).toBeInTheDocument()
})

it('keeps primary and step navigation actionable with clear validation feedback', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  const App = (await import('./App')).default
  render(<App />)
  await screen.findByText(/演示模式/)

  fireEvent.click(screen.getByRole('button', { name: /手动精确配置/ }))
  const next = screen.getByRole('button', { name: /下一步：配置厨房/ })
  expect(next).toBeEnabled()
  fireEvent.click(next)
  expect(await screen.findByText('请选择 3～5 道不同的菜')).toBeInTheDocument()

  for (const recipe of recipeCatalog.slice(0, 3)) fireEvent.click(screen.getByRole('button', { name: new RegExp(recipe.name) }))
  const steps = within(screen.getByRole('navigation', { name: '排程创建步骤' }))
  fireEvent.click(steps.getByRole('button', { name: /厨房条件/ }))
  expect(await screen.findByText('告诉我你的厨房现在有什么')).toBeInTheDocument()

  fireEvent.click(steps.getByRole('button', { name: /选择菜谱/ }))
  expect(await screen.findByText('选择今天要做的菜')).toBeInTheDocument()
  fireEvent.click(steps.getByRole('button', { name: /确认步骤/ }))
  expect(await screen.findByText('确认菜谱解析结果')).toBeInTheDocument()
})

it('HTTP: real non-Demo selection flows into ExecutionDashboard and delayed replan with the identical request', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  let initialRequest: any
  let replanEnvelope: any
  const parseUrls: string[] = []
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://test').pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path === '/recipes') return json({ recipes: ids.map((id, index) => ({ recipe_id: id, name: `真实菜${index}`, step_count: 1, ingredient_count: 1 })) })
    if (path === '/settings/model') return json({ parser_provider: 'llm', configured: true, ready: true, base_url: 'https://models.example.test/v1', model: 'test-model', api_key_masked: 'sk-test', source: 'runtime', notes: [] })
    if (path.startsWith('/recipes/') && path !== '/recipes/parse') return json({ schema_version: '1.0', recipe_id: path.split('/').pop(), name: '真实菜', ingredients: ['食材'], steps_text: ['备料一分钟'] })
    if (path === '/recipes/parse') { parseUrls.push(url); return json({ schema_version: '1.0', recipe_id: body.recipe_id, provider: 'deterministic', tasks: tasks.filter(task => task.dish_id === body.recipe_id) }) }
    if (path === '/devices/validate') return json({ valid: true, errors: [] })
    if (path === '/schedules') { initialRequest = body; return json({ ...schedule, request_id: body.request_id }) }
    if (path === '/v1/replans') {
      replanEnvelope = body
      return json({ schema_version: '1.0', event_id: body.event.event_id, previous_schedule_id: body.current_schedule.schedule_id, schedule: body.current_schedule, changes: [], disruption_metrics: { start_offset_total_sec: 0, resource_change_count: 0, order_change_count: 0, notified_task_change_count: 0 }, disruption_score: 0 })
    }
    throw new Error(`Unexpected backend/Demo request: ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
  const App = (await import('./App')).default
  render(<App />)
  await flow(['真实菜0', '真实菜1', '真实菜2'])
  fireEvent.click(screen.getAllByRole('button', { name: /处理并腌制鲈鱼/ })[0])
  fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
  fireEvent.click(await screen.findByRole('button', { name: '发生延迟' }))
  await waitFor(() => expect(replanEnvelope).toBeDefined())
  expect(initialRequest.tasks.map((task: any) => task.dish_id)).toEqual(ids)
  expect(replanEnvelope.schedule_request).toEqual(initialRequest)
  expect(replanEnvelope.event.event_type).toBe('TASK_DELAYED')
  expect(replanEnvelope.current_schedule).not.toHaveProperty('resources')
  expect(fetcher.mock.calls.some(([url]) => url.includes('/demo/'))).toBe(false)
  expect(parseUrls).toHaveLength(3)
  expect(parseUrls.every(url => !url.includes('provider=llm'))).toBe(true)
  for (const endpoint of ['/recipes', '/recipes/parse', '/devices/validate', '/schedules', '/v1/replans']) expect(fetcher.mock.calls.some(([url]) => new URL(url).pathname === endpoint)).toBe(true)
})

it.each(['mock', undefined])('Mock (%s): completes selection, kitchen, confirmation and selected-dish results without any backend fetch', async mode => {
  vi.stubEnv('VITE_API_MODE', mode)
  const fetcher = vi.fn().mockRejectedValue(new Error('Backend must not be requested'))
  vi.stubGlobal('fetch', fetcher)
  const App = (await import('./App')).default
  render(<App />)
  await screen.findByText(/演示模式/)
  await flow(recipeCatalog.slice(0, 3).map(recipe => recipe.name))
  for (const recipe of recipeCatalog.slice(0, 3)) expect(screen.getAllByRole('button', { name: new RegExp(`${recipe.name}备料`) })[0]).toBeInTheDocument()
  expect(fetcher).not.toHaveBeenCalled()
})


it('requires a configured model before enabling the Agent conversation', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  const App = (await import('./App')).default
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /Agent 智能规划/ }))
  expect(screen.getByText('说完需求，我来安排')).toBeInTheDocument()
  expect(screen.getByText('如果使用此功能，请先到右上角的设置配置大模型哦！')).toBeInTheDocument()
  expect(screen.getByLabelText('告诉智能助手你的做饭需求')).toBeDisabled()
  expect(screen.getByRole('button', { name: '发送 ↑' })).toBeDisabled()
})
