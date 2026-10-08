import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import responseExample from '../../contracts/v1/examples/schedule-response-v1.json'
import taskExample from '../../contracts/v1/examples/schedule-request-v1.json'
import { recipeCatalog } from './mock/recipes'

const ids = ['review_real_a', 'review_real_b', 'review_real_c']
const tasks = ids.map(id => ({ ...taskExample.tasks[0], task_id: `${id}_prepare`, dish_id: id, predecessors: [] }))
const schedule = { ...responseExample, tasks: tasks.map((task, index) => ({ task_id: task.task_id, dish_id: task.dish_id, start_offset_sec: index * task.duration_sec, end_offset_sec: (index + 1) * task.duration_sec, assigned_resources: ['operator_1'], status: 'PENDING', locked: false, notification_points: [] })) }
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

function recipeCardButton(name: string) {
  const button = screen.getByText(name, { selector: '.recipe-card strong', exact: true }).closest('button')
  expect(button).not.toBeNull()
  return button!
}

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
  await screen.findByText('排程已生成')
  expect(screen.queryByText('接下来做什么')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '开始做饭 →' }))
  await screen.findByText('接下来做什么')
}

it('keeps the homepage focused on two planning entries', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  const App = (await import('./App')).default
  render(<App />)
  await screen.findByText(/演示模式/)

  expect(screen.getByText('今天的菜单')).toBeInTheDocument()
  expect(screen.queryByText('选好菜，')).not.toBeInTheDocument()
  expect(screen.queryByRole('navigation', { name: '排程创建步骤' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /直接告诉我今晚怎么吃/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /按步骤选择与设置/ })).toBeInTheDocument()
})

it('opens the full manual recipe catalog after entering the manual flow', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  const App = (await import('./App')).default
  render(<App />)
  await screen.findByText(/演示模式/)
  fireEvent.click(screen.getByRole('button', { name: /按步骤选择与设置/ }))

  const steps = within(screen.getByRole('navigation', { name: '排程创建步骤' }))
  fireEvent.click(steps.getByRole('button', { name: /选择菜谱/ }))
  expect(await screen.findByText('选择今天要做的菜')).toBeInTheDocument()
  expect(screen.getAllByText((_, element) => element?.textContent?.includes(`已接入 ${recipeCatalog.length} 道官方菜谱`) ?? false).length).toBeGreaterThan(0)
  expect(screen.getByRole('button', { name: new RegExp(recipeCatalog[0].name) })).toBeInTheDocument()
})

it('manual selection requires 3 dishes, allows 3-5, and never selects a sixth dish', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  const App = (await import('./App')).default
  render(<App />)
  await screen.findByText(/演示模式/)

  fireEvent.click(screen.getByRole('button', { name: /手动精确配置/ }))
  const next = screen.getByRole('button', { name: /下一步：配置厨房/ })
  expect(next).toBeDisabled()

  for (const recipe of recipeCatalog.slice(0, 2)) fireEvent.click(recipeCardButton(recipe.name))
  expect(next).toBeDisabled()

  fireEvent.click(recipeCardButton(recipeCatalog[2].name))
  expect(next).toBeEnabled()

  fireEvent.click(recipeCardButton(recipeCatalog[3].name))
  fireEvent.click(recipeCardButton(recipeCatalog[4].name))
  expect(screen.getByText('5', { selector: '.selection-panel-heading > strong' })).toBeInTheDocument()
  const sixth = recipeCardButton(recipeCatalog[5].name)
  fireEvent.click(sixth)
  expect(sixth).toHaveAttribute('aria-pressed', 'false')
  expect(next).toBeEnabled()

  fireEvent.click(next)
  expect(await screen.findByText('告诉我你的厨房现在有什么')).toBeInTheDocument()
})

it('HTTP: kitchen configuration reaches the real schedule request and the generated schedule is reused when cooking starts', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  let initialRequest: any
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
    throw new Error(`Unexpected backend/Demo request: ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
  const App = (await import('./App')).default
  render(<App />)

  fireEvent.click(await screen.findByRole('button', { name: /手动精确配置/ }))
  for (const name of ['真实菜0', '真实菜1', '真实菜2']) fireEvent.click(await screen.findByRole('button', { name: new RegExp(name) }))
  fireEvent.click(screen.getByRole('button', { name: /下一步：配置厨房/ }))
  await screen.findByText('告诉我你的厨房现在有什么')

  fireEvent.change(screen.getByLabelText('灶眼', { selector: 'input' }), { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: /下一步：解析确认/ }))
  await screen.findByText('确认菜谱解析结果')
  expect(screen.getByText(/2 个灶眼/)).toBeInTheDocument()
  expect(screen.getByText(/1 台冰箱/)).toBeInTheDocument()
  expect(screen.getByText(/1 台洗碗机/)).toBeInTheDocument()
  expect(screen.getByText(/1 台烟机/)).toBeInTheDocument()
  expect(screen.getByText(/1 台净水机/)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /返回配置/ }))
  expect(await screen.findByLabelText('灶眼', { selector: 'input' })).toHaveValue(2)
  fireEvent.click(screen.getByRole('button', { name: /下一步：解析确认/ }))
  await screen.findByText('确认菜谱解析结果')

  fireEvent.click(screen.getAllByRole('checkbox')[0])
  fireEvent.click(screen.getByRole('button', { name: /生成初始排程/ }))
  await screen.findByText('排程已生成')
  expect(screen.queryByText('接下来做什么')).not.toBeInTheDocument()
  expect(initialRequest.device_config.devices.filter((device: any) => device.device_type === 'stove')).toHaveLength(2)
  expect(parseUrls).toHaveLength(6)
  expect(parseUrls.every(url => !url.includes('provider=llm'))).toBe(true)
  expect(fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/schedules')).toHaveLength(1)

  fireEvent.click(screen.getByRole('button', { name: '开始做饭 →' }))
  expect(await screen.findByText('接下来做什么')).toBeInTheDocument()
  expect(fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/schedules')).toHaveLength(1)
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/demo/'))).toBe(false)
})

it('HTTP: device validation failure stays on kitchen configuration and never creates a schedule', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  const fetcher = vi.fn(async (url: string) => {
    const path = new URL(url, 'http://test').pathname
    if (path === '/recipes') return json({ recipes: ids.map((id, index) => ({ recipe_id: id, name: `校验菜${index}`, step_count: 1, ingredient_count: 1 })) })
    if (path === '/settings/model') return json({ parser_provider: 'deterministic', configured: false, ready: false, base_url: null, model: 'gpt-4o-mini', api_key_masked: null, source: 'runtime', notes: [] })
    if (path === '/devices/validate') return json({ valid: false, errors: [{ code: 'DEVICE_INVALID', path: 'devices', message: '设备配置不可用' }] })
    throw new Error(`Unexpected request after validation failure: ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
  const App = (await import('./App')).default
  render(<App />)

  fireEvent.click(await screen.findByRole('button', { name: /手动精确配置/ }))
  for (const name of ['校验菜0', '校验菜1', '校验菜2']) fireEvent.click(await screen.findByRole('button', { name: new RegExp(name) }))
  fireEvent.click(screen.getByRole('button', { name: /下一步：配置厨房/ }))
  await screen.findByText('告诉我你的厨房现在有什么')
  fireEvent.click(screen.getByRole('button', { name: /下一步：解析确认/ }))

  expect(await screen.findByText(/厨房设备配置未通过校验/)).toBeInTheDocument()
  expect(screen.getByText('告诉我你的厨房现在有什么')).toBeInTheDocument()
  expect(screen.queryByText('确认菜谱解析结果')).not.toBeInTheDocument()
  expect(fetcher.mock.calls.some(([url]) => new URL(String(url)).pathname === '/schedules')).toBe(false)
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
  expect(screen.getByText('请跟智能agent交流你的晚餐')).toBeInTheDocument()
  expect(screen.getByText('如果使用此功能，请先到右上角的设置配置大模型哦！')).toBeInTheDocument()
  expect(screen.getByLabelText('告诉智能助手你的做饭需求')).toBeDisabled()
  expect(screen.getByRole('button', { name: '发送 ↑' })).toBeDisabled()
})
