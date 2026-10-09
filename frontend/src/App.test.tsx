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
  // A wall-clock time alone is no longer accepted, so pick an explicit day that
  // is guaranteed to be in the future regardless of when the suite runs.
  fireEvent.click(screen.getByRole('button', { name: '明天' }))
  fireEvent.click(screen.getByRole('button', { name: /下一步：解析确认/ }))
  await screen.findByText('确认菜谱解析结果')
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  fireEvent.click(screen.getByRole('button', { name: /生成初始排程/ }))
  await screen.findByText('排程已生成')
  expect(screen.queryByText('接下来做什么')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '开始做饭 →' }))
  await screen.findByText('接下来做什么')
}

it('keeps the landing page free of manual progress and moves it into manual configuration', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  const App = (await import('./App')).default
  render(<App />)
  await screen.findByText('服务已连接')

  expect(screen.queryByRole('navigation', { name: '排程创建步骤' })).not.toBeInTheDocument()
  expect(screen.queryByText('/ 5 道已选')).not.toBeInTheDocument()
  expect(screen.queryByText('准时开饭。')).not.toBeInTheDocument()
  expect(screen.getByText('灶序・CookFlow')).toBeInTheDocument()
  expect(screen.getByText('自然语言驱动规划')).toBeInTheDocument()
  expect(screen.getByText('自定义时序编排')).toBeInTheDocument()
  expect(screen.getByText('开始规划')).toBeInTheDocument()
  expect(screen.getByText('进入编排')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /手动精确配置/ }))
  const steps = within(screen.getByRole('navigation', { name: '排程创建步骤' }))
  expect(steps.getAllByRole('button')).toHaveLength(4)
  expect(steps.getByRole('button', { name: /选择菜谱/ })).toHaveAttribute('aria-current', 'step')
  expect(screen.getByLabelText('已选择 0 道菜，最多 5 道')).toBeInTheDocument()
  expect(await screen.findByText('选择今天要做的菜')).toBeInTheDocument()
  expect(screen.getAllByText((_, element) => element?.textContent?.includes(`已接入 ${recipeCatalog.length} 道官方菜谱`) ?? false).length).toBeGreaterThan(0)

  fireEvent.click(recipeCardButton(recipeCatalog[0].name))
  expect(screen.getByLabelText('已选择 1 道菜，最多 5 道')).toBeInTheDocument()
})

it('does not show manual progress in Agent planning', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  const App = (await import('./App')).default
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /AGENT 智能规划/ }))
  const stepper = within(screen.getByRole('navigation', { name: '排程创建步骤' }))
  expect(stepper.getAllByRole('button')).toHaveLength(3)
  expect(stepper.getByRole('button', { name: /收集需求/ })).toBeInTheDocument()
  expect(stepper.getByRole('button', { name: /确认信息/ })).toBeInTheDocument()
  expect(stepper.getByRole('button', { name: /开始做饭/ })).toBeInTheDocument()
  expect(stepper.queryByRole('button', { name: /选择菜谱|厨房条件|确认步骤/ })).not.toBeInTheDocument()
  expect(screen.queryByText('/ 5 道已选')).not.toBeInTheDocument()
})

it('manual selection requires 3 dishes, allows 3-5, and never selects a sixth dish', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  const App = (await import('./App')).default
  render(<App />)
  await screen.findByText('服务已连接')

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
    if (path === '/schedules/staged') {
      initialRequest = body.schedule_request
      return json({ schema_version: '1.0', request_id: initialRequest.request_id,
        status: 'READY', can_start_main: true, advance_task_ids: [], pending_advance_task_ids: [],
        review_required: [], advance_schedule: null,
        main_schedule: { ...schedule, request_id: initialRequest.request_id },
        executable_main_request: initialRequest,
        timing: { target_ready_at: initialRequest.device_config.target_ready_at,
          suggested_advance_start_at: null, advance_finish_by: null, suggested_main_start_at: null,
          advance_makespan_sec: 0, main_makespan_sec: 780, total_elapsed_sec: 780,
          advance_start_offset_sec: 0, main_start_offset_sec: 0, total_finish_offset_sec: 780 } })
    }
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
  // Pick an explicit future day: a bare clock time is no longer a valid deadline.
  fireEvent.click(screen.getByRole('button', { name: '明天' }))
  fireEvent.click(screen.getByRole('button', { name: /下一步：解析确认/ }))
  await screen.findByText('确认菜谱解析结果')
  expect(screen.getByText(/2 个灶眼/)).toBeInTheDocument()
  expect(screen.getByText(/1 台冰箱/)).toBeInTheDocument()
  expect(screen.getByText(/1 台洗碗机/)).toBeInTheDocument()
  expect(screen.getByText(/1 台烟机/)).toBeInTheDocument()
  expect(screen.getByText(/1 台净水机/)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /返回配置/ }))
  expect(await screen.findByLabelText('灶眼', { selector: 'input' })).toHaveValue(2)
  // Pick an explicit future day: a bare clock time is no longer a valid deadline.
  fireEvent.click(screen.getByRole('button', { name: '明天' }))
  fireEvent.click(screen.getByRole('button', { name: /下一步：解析确认/ }))
  await screen.findByText('确认菜谱解析结果')

  fireEvent.click(screen.getAllByRole('checkbox')[0])
  fireEvent.click(screen.getByRole('button', { name: /生成初始排程/ }))
  await screen.findByText('排程已生成')
  expect(screen.queryByText('接下来做什么')).not.toBeInTheDocument()
  expect(initialRequest.device_config.devices.filter((device: any) => device.device_type === 'stove')).toHaveLength(2)
  expect(parseUrls).toHaveLength(6)
  expect(parseUrls.every(url => !url.includes('provider=llm'))).toBe(true)
  expect(fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/schedules/staged')).toHaveLength(1)
  const result = within(screen.getByRole('region', { name: '排程结果确认' }))
  expect(result.getByText('建议开始')).toBeInTheDocument()
  // Suggested start keeps the day too, so a deadline that is not today is never
  // mistaken for a same-day clock time.
  expect(result.getByText('10月10日 12:17')).toBeInTheDocument()
  expect(result.getByText('目标开饭')).toBeInTheDocument()
  // The deadline is shown as a full local date + time, not a bare clock time,
  // so the day the user picked is unambiguous on the result page. It appears
  // both as the headline value and in the supporting note.
  expect(result.getAllByText(/10月\d+日 12:30/).length).toBeGreaterThan(0)
  expect(result.getByText('预计总用时')).toBeInTheDocument()
  expect(result.getByText('13 分钟')).toBeInTheDocument()
  expect(result.getByText('已通过约束校验')).toBeInTheDocument()
  for (const name of ['真实菜0', '真实菜1', '真实菜2']) expect(result.getByText(name)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '开始做饭 →' }))
  expect(await screen.findByText('接下来做什么')).toBeInTheDocument()
  expect(fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/schedules/staged')).toHaveLength(1)
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/demo/'))).toBe(false)
})

it('HTTP: advance preparation is included in total elapsed time and requires explicit confirmation before main execution', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  const advanceId = `${ids[0]}_advance`
  let stagedCalls = 0
  let lastMainRequest: any
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://test').pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path === '/recipes') return json({ recipes: ids.map((id, index) => ({ recipe_id: id, name: `阶段菜${index}`, step_count: id === ids[0] ? 2 : 1, ingredient_count: 1 })) })
    if (path === '/settings/model') return json({ parser_provider: 'deterministic', configured: false, ready: false, base_url: null, model: 'gpt-4o-mini', api_key_masked: null, source: 'runtime', notes: [] })
    if (path.startsWith('/recipes/') && path !== '/recipes/parse') return json({ schema_version: '1.0', recipe_id: path.split('/').pop(), name: '阶段菜', ingredients: ['食材'], steps_text: ['冷冻24小时', '做饭'] })
    if (path === '/recipes/parse') {
      const id = body.recipe_id
      const found = tasks.find(task => task.dish_id === id)!
      return json({ schema_version: '1.0', recipe_id: id, provider: 'deterministic', tasks: id === ids[0]
        ? [{ ...found, task_id: advanceId, action: '提前冷冻24小时', duration_sec: 86400, resource_type: 'wait', manual_required: false, manual_duration_sec: 0, manual_segments: [] }, { ...found, predecessors: [advanceId] }]
        : [found] })
    }
    if (path === '/devices/validate') return json({ valid: true, errors: [] })
    if (path === '/schedules/staged') {
      stagedCalls++
      const original = body.schedule_request
      const advance = original.tasks.find((task: any) => task.task_id === advanceId)
      const mainTasks = original.tasks.filter((task: any) => task.task_id !== advanceId)
      const executable = { ...original, request_id: `${original.request_id}_main`, tasks: mainTasks.map((task: any) => ({ ...task, predecessors: task.predecessors.filter((id: string) => id !== advanceId) })) }
      lastMainRequest = executable
      const done = body.confirmed_advance_task_ids.includes(advanceId)
      return json({ schema_version: '1.0', request_id: original.request_id,
        status: done ? 'READY' : 'PREPARATION_REQUIRED', can_start_main: done,
        advance_task_ids: [advanceId], pending_advance_task_ids: done ? [] : [advanceId], review_required: [],
        advance_schedule: { ...schedule, request_id: `${original.request_id}_advance`, tasks: [{ ...schedule.tasks[0], task_id: advanceId, dish_id: ids[0], start_offset_sec: 0, end_offset_sec: 86400 }], metrics: { ...schedule.metrics, makespan_sec: 86400 } },
        main_schedule: { ...schedule, request_id: executable.request_id },
        executable_main_request: done ? executable : null,
        timing: { target_ready_at: original.device_config.target_ready_at, suggested_advance_start_at: null,
          advance_finish_by: null, suggested_main_start_at: null, advance_makespan_sec: 86400,
          main_makespan_sec: 780, total_elapsed_sec: 87180, advance_start_offset_sec: 0,
          main_start_offset_sec: 86400, total_finish_offset_sec: 87180 } })
    }
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
  const App = (await import('./App')).default
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /手动精确配置/ }))
  for (const name of ['阶段菜0', '阶段菜1', '阶段菜2']) fireEvent.click(await screen.findByRole('button', { name: new RegExp(name) }))
  fireEvent.click(screen.getByRole('button', { name: /下一步：配置厨房/ }))
  await screen.findByText('告诉我你的厨房现在有什么')
  // Pick an explicit future day: a bare clock time is no longer a valid deadline.
  fireEvent.click(screen.getByRole('button', { name: '明天' }))
  fireEvent.click(screen.getByRole('button', { name: /下一步：解析确认/ }))
  await screen.findByText('确认菜谱解析结果')
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  fireEvent.click(screen.getByRole('button', { name: /生成初始排程/ }))
  const result = within(await screen.findByRole('region', { name: '排程结果确认' }))
  expect(result.getByText('整体总历时（含提前准备）')).toBeInTheDocument()
  expect(result.getByText('24 小时 13 分钟')).toBeInTheDocument()
  expect(within(result.getByLabelText('分阶段排程指标')).getByText('24 小时')).toBeInTheDocument()
  expect(result.getByText('13 分钟')).toBeInTheDocument()
  expect(result.getByRole('button', { name: '开始做饭 →' })).toBeDisabled()
  const advance = within(result.getByRole('region', { name: '提前准备计划' }))
  expect(advance.getByText('阶段菜0')).toBeInTheDocument()
  expect(advance.getByText('提前冷冻24小时')).toBeInTheDocument()
  expect(advance.queryByText(ids[0])).not.toBeInTheDocument()
  expect(advance.getByText('预计需要 24 小时')).toBeInTheDocument()
  const confirm = result.getByRole('button', { name: /确认 1 项提前准备已实际完成/ })
  expect(confirm).toBeDisabled()
  fireEvent.click(result.getByRole('checkbox'))
  expect(confirm).toBeEnabled()
  fireEvent.click(confirm)
  await screen.findByText('全部提前准备已确认，可以开始正式烹饪')
  expect(stagedCalls).toBe(2)
  expect(lastMainRequest.tasks.map((task: any) => task.task_id)).not.toContain(advanceId)
  expect(result.getByRole('button', { name: '开始做饭 →' })).toBeEnabled()
  fireEvent.click(result.getByRole('button', { name: '开始做饭 →' }))
  expect(await screen.findByText('接下来做什么')).toBeInTheDocument()
  expect(fetcher.mock.calls.some(([url]) => new URL(String(url)).pathname === '/schedules')).toBe(false)
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
  // Pick an explicit future day: a bare clock time is no longer a valid deadline.
  fireEvent.click(screen.getByRole('button', { name: '明天' }))
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
  await screen.findByText('服务已连接')
  await flow(recipeCatalog.slice(0, 3).map(recipe => recipe.name))
  for (const recipe of recipeCatalog.slice(0, 3)) expect(screen.getAllByRole('button', { name: new RegExp(`${recipe.name}备料`) })[0]).toBeInTheDocument()
  expect(fetcher).not.toHaveBeenCalled()
})

it('Agent collects the plan, then shares the public confirmation and execution flow', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  const agentRecipes = [
    { recipe_id: '6510fb3545256c3ad7c25c9c', name: '苹果芒果派', step_count: 1, ingredient_count: 1 },
    { recipe_id: '661369554b3d03197733ac5a', name: '香烤排骨', step_count: 1, ingredient_count: 1 },
    { recipe_id: '58e70b129f6429675ec80601', name: '麻辣对虾', step_count: 1, ingredient_count: 1 },
  ]
  const agentTasks = agentRecipes.map(({ recipe_id }) => ({ ...taskExample.tasks[0], task_id: `${recipe_id}_prepare`, dish_id: recipe_id, predecessors: [] }))
  const agentSchedule = { ...schedule, tasks: agentTasks.map((task, index) => ({ task_id: task.task_id, dish_id: task.dish_id, start_offset_sec: index * task.duration_sec, end_offset_sec: (index + 1) * task.duration_sec, assigned_resources: ['operator_1'], status: 'PENDING', locked: false, notification_points: [] })) }
  const parseUrls: string[] = []
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://test').pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path === '/recipes') return json({ recipes: agentRecipes })
    if (path === '/settings/model') return json({ parser_provider: 'llm', configured: true, ready: true, base_url: 'https://models.example.test/v1', model: 'test-model', api_key_masked: 'sk-test', source: 'runtime', notes: [] })
    if (path === '/agent/plan') return json({
      intent: 'create_schedule', reply: '信息已确认，请进入菜谱步骤确认。',
      draft: {
        recipes: agentRecipes.map(({ recipe_id, name }) => ({ recipe_id, name })), target_time: '18:30', operator_count: 1,
        devices: { stove_count: 1, steamer_count: 1, oven_count: 1, refrigerator_count: 1, dishwasher_count: 1, range_hood_count: 1, water_purifier_count: 1 },
      }, missing_fields: [], unmatched_recipe_names: [], ready_to_confirm: true,
      tool_trace: [{ name: 'understand_request', status: 'completed', label: '大模型已理解本轮需求' }],
    })
    if (path.startsWith('/recipes/') && path !== '/recipes/parse') return json({ schema_version: '1.0', recipe_id: path.split('/').pop(), name: '官方菜谱', ingredients: ['食材'], steps_text: ['备料一分钟'] })
    if (path === '/recipes/parse') { parseUrls.push(url); return json({ schema_version: '1.0', recipe_id: body.recipe_id, provider: 'deterministic', tasks: agentTasks.filter(task => task.dish_id === body.recipe_id) }) }
    if (path === '/devices/validate') return json({ valid: true, errors: [] })
    if (path === '/schedules') return json({ ...agentSchedule, request_id: body.request_id })
    throw new Error(`Unexpected backend request: ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
  const App = (await import('./App')).default
  render(<App />)

  fireEvent.click(await screen.findByRole('button', { name: /AGENT 智能规划/ }))
  const input = await screen.findByRole('textbox', { name: '告诉智能助手你的做饭需求' })
  fireEvent.change(input, { target: { value: '安排今晚的做饭计划' } })
  fireEvent.click(screen.getByRole('button', { name: /发送/ }))
  await screen.findByText('信息已确认，请进入菜谱步骤确认。')
  fireEvent.click(screen.getByRole('button', { name: /进入菜谱步骤确认/ }))

  await screen.findByText('确认菜谱解析结果')
  const agentStepper = within(screen.getByRole('navigation', { name: '排程创建步骤' }))
  expect(agentStepper.getAllByRole('button')).toHaveLength(3)
  expect(agentStepper.getByRole('button', { name: /收集需求/ })).toHaveClass('done')
  expect(agentStepper.getByRole('button', { name: /确认信息/ })).toHaveAttribute('aria-current', 'step')
  expect(agentStepper.getByRole('button', { name: /开始做饭/ })).toBeInTheDocument()
  expect(agentStepper.queryByRole('button', { name: /确认步骤/ })).not.toBeInTheDocument()
  expect(screen.getByText(/Agent智能规划/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /返回修改需求/ })).toBeInTheDocument()
  expect(parseUrls).toHaveLength(3)
  expect(parseUrls.every(url => !url.includes('provider=llm'))).toBe(true)

  fireEvent.click(screen.getByRole('button', { name: /返回修改需求/ }))
  expect(await screen.findByRole('textbox', { name: '告诉智能助手你的做饭需求' })).toBeInTheDocument()
  expect(screen.getByText('信息已确认，请进入菜谱步骤确认。')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /进入菜谱步骤确认/ }))
  await screen.findByText('确认菜谱解析结果')
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  fireEvent.click(screen.getByRole('button', { name: /生成初始排程/ }))
  await screen.findByText('排程已生成')
  const resultStepper = within(screen.getByRole('navigation', { name: '排程创建步骤' }))
  expect(resultStepper.getByRole('button', { name: /确认信息/ })).toHaveClass('done')
  expect(resultStepper.getByRole('button', { name: /开始做饭/ })).toHaveAttribute('aria-current', 'step')
  fireEvent.click(screen.getByRole('button', { name: '开始做饭 →' }))
  await screen.findByText('接下来做什么')
  expect(fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/schedules')).toHaveLength(1)
})

it('requires a configured model before enabling the Agent conversation', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  const App = (await import('./App')).default
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /AGENT 智能规划/ }))
  expect(screen.getByText('先说说你的做饭需求')).toBeInTheDocument()
  expect(screen.getByText('如果使用此功能，请先到右上角的设置配置大模型哦！')).toBeInTheDocument()
  expect(screen.getByLabelText('告诉智能助手你的做饭需求')).toBeDisabled()
  expect(screen.getByRole('button', { name: '发送 ↑' })).toBeDisabled()
})

it('persists the planning session and restores it after a refresh', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  let App = (await import('./App')).default
  const first = render(<App />)
  await screen.findByText('服务已连接')
  fireEvent.click(screen.getByRole('button', { name: /手动精确配置/ }))
  await screen.findByText(recipeCatalog[0].name, { selector: '.recipe-card strong', exact: true })
  for (const recipe of recipeCatalog.slice(0, 3)) fireEvent.click(recipeCardButton(recipe.name))
  const saved = JSON.parse(localStorage.getItem('cookflow.session.v1')!)
  expect(saved.planningMode).toBe('manual')
  expect(saved.selectedIds).toHaveLength(3)
  first.unmount()

  vi.resetModules()
  App = (await import('./App')).default
  render(<App />)
  await screen.findByText(recipeCatalog[0].name, { selector: '.recipe-card strong', exact: true })
  expect(screen.getByLabelText('已选择 3 道菜，最多 5 道')).toBeInTheDocument()
})

it('reset button clears the persisted session and returns to the landing', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  vi.stubGlobal('confirm', vi.fn(() => true))
  const App = (await import('./App')).default
  render(<App />)
  await screen.findByText('服务已连接')
  fireEvent.click(screen.getByRole('button', { name: /手动精确配置/ }))
  await screen.findByText(recipeCatalog[0].name, { selector: '.recipe-card strong', exact: true })
  for (const recipe of recipeCatalog.slice(0, 3)) fireEvent.click(recipeCardButton(recipe.name))
  expect(JSON.parse(localStorage.getItem('cookflow.session.v1')!).selectedIds).toHaveLength(3)

  fireEvent.click(screen.getByRole('button', { name: '重置' }))
  const after = JSON.parse(localStorage.getItem('cookflow.session.v1')!)
  expect(after.planningMode).toBe('choose')
  expect(after.selectedIds).toHaveLength(0)
  expect(screen.getByText('自然语言驱动规划')).toBeInTheDocument()
  expect(screen.getByText('自定义时序编排')).toBeInTheDocument()
})

it('exits the manual dish selection back to the homepage', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  const App = (await import('./App')).default
  render(<App />)
  await screen.findByText('服务已连接')

  fireEvent.click(screen.getByRole('button', { name: /手动精确配置/ }))
  expect(await screen.findByText('选择今天要做的菜')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /返回主页/ })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /返回主页/ }))
  expect(screen.getByText('自然语言驱动规划')).toBeInTheDocument()
  expect(screen.getByText('自定义时序编排')).toBeInTheDocument()
  expect(screen.queryByText('选择今天要做的菜')).not.toBeInTheDocument()
})
