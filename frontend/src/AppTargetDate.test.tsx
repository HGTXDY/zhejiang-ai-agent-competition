/**
 * Fix 05 · 开饭日期与时间口径的端到端覆盖。
 *
 * Every test pins the system clock so "today"/"tomorrow"/"already passed" mean
 * the same thing on any machine and in any timezone. The HTTP harness mirrors
 * the shape `/schedules/staged` really returns (see backend/app/staged_planning.py).
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import responseExample from '../../contracts/v1/examples/schedule-response-v1.json'
import taskExample from '../../contracts/v1/examples/schedule-request-v1.json'

const ids = ['date_real_a', 'date_real_b', 'date_real_c']
const ADVANCE_ID = `${ids[0]}_advance`
const NAMES = ['日期菜0', '日期菜1', '日期菜2']

/** 2026-10-09 is a Friday; 09:00 local leaves room for a same-day deadline. */
const FIXED_NOW = new Date(2026, 9, 9, 9, 0, 0)

const tasks = ids.map(id => ({ ...taskExample.tasks[0], task_id: `${id}_prepare`, dish_id: id, predecessors: [] }))
const schedule = {
  ...responseExample,
  tasks: tasks.map((task, index) => ({
    task_id: task.task_id, dish_id: task.dish_id,
    start_offset_sec: index * task.duration_sec, end_offset_sec: (index + 1) * task.duration_sec,
    assigned_resources: ['operator_1'], status: 'PENDING', locked: false, notification_points: [],
  })),
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

interface Harness {
  stagedRequests: { schedule_request: any; confirmed_advance_task_ids: string[] }[]
  /** Deadline instant the frontend actually sent for the most recent request. */
  lastTargetReadyAt: () => string | null
}

/**
 * @param options.withAdvance  add a 24h cold hold so staged timing has two phases
 * @param options.advanceStart when set, the suggested advance start (drives the "already passed" warning)
 */
function installHarness(options: { withAdvance?: boolean; advanceStart?: string | null } = {}): Harness {
  const { withAdvance = false, advanceStart = null } = options
  const stagedRequests: Harness['stagedRequests'] = []
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://test').pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path === '/recipes') {
      return json({ recipes: ids.map((id, index) => ({ recipe_id: id, name: NAMES[index], step_count: withAdvance && index === 0 ? 2 : 1, ingredient_count: 1 })) })
    }
    if (path === '/settings/model') {
      return json({ parser_provider: 'deterministic', configured: false, ready: false, base_url: null, model: 'gpt-4o-mini', api_key_masked: null, source: 'runtime', notes: [] })
    }
    if (path.startsWith('/recipes/') && path !== '/recipes/parse') {
      return json({ schema_version: '1.0', recipe_id: path.split('/').pop(), name: '日期菜', ingredients: ['食材'], steps_text: ['备料一分钟'] })
    }
    if (path === '/recipes/parse') {
      const id = body.recipe_id as string
      const found = tasks.find(task => task.dish_id === id)!
      const parsed = withAdvance && id === ids[0]
        ? [
            { ...found, task_id: ADVANCE_ID, action: '提前冷冻24小时', duration_sec: 86400, resource_type: 'wait', manual_required: false, manual_duration_sec: 0, manual_segments: [] },
            { ...found, predecessors: [ADVANCE_ID] },
          ]
        : [found]
      return json({ schema_version: '1.0', recipe_id: id, provider: 'deterministic', tasks: parsed })
    }
    if (path === '/devices/validate') return json({ valid: true, errors: [] })
    if (path === '/schedules/staged') {
      const request = body.schedule_request
      const confirmedIds: string[] = body.confirmed_advance_task_ids ?? []
      stagedRequests.push({ schedule_request: request, confirmed_advance_task_ids: confirmedIds })

      const advanceTasks = withAdvance ? request.tasks.filter((task: any) => task.task_id === ADVANCE_ID) : []
      const mainTasks = request.tasks.filter((task: any) => task.task_id !== ADVANCE_ID)
      const executable = {
        ...request,
        request_id: `${request.request_id}_main`,
        tasks: mainTasks.map((task: any) => ({ ...task, predecessors: task.predecessors.filter((id: string) => id !== ADVANCE_ID) })),
      }
      const done = advanceTasks.length === 0 || advanceTasks.every((task: any) => confirmedIds.includes(task.task_id))
      const targetReadyAt = request.device_config.target_ready_at
      const advanceMakespan = withAdvance ? 86400 : 0
      const mainMakespan = 780
      return json({
        schema_version: '1.0',
        request_id: request.request_id,
        status: done ? 'READY' : 'PREPARATION_REQUIRED',
        can_start_main: done,
        advance_task_ids: advanceTasks.map((task: any) => task.task_id),
        pending_advance_task_ids: done ? [] : advanceTasks.map((task: any) => task.task_id),
        review_required: [],
        advance_schedule: withAdvance
          ? { ...schedule, request_id: `${request.request_id}_advance`, tasks: [{ ...schedule.tasks[0], task_id: ADVANCE_ID, dish_id: ids[0], start_offset_sec: 0, end_offset_sec: 86400 }], metrics: { ...schedule.metrics, makespan_sec: advanceMakespan } }
          : null,
        main_schedule: { ...schedule, request_id: executable.request_id },
        executable_main_request: done ? executable : null,
        timing: {
          target_ready_at: targetReadyAt,
          suggested_advance_start_at: advanceStart,
          advance_finish_by: null,
          suggested_main_start_at: null,
          advance_makespan_sec: advanceMakespan,
          main_makespan_sec: mainMakespan,
          total_elapsed_sec: advanceMakespan + mainMakespan,
          advance_start_offset_sec: 0,
          main_start_offset_sec: advanceMakespan,
          total_finish_offset_sec: advanceMakespan + mainMakespan,
        },
      })
    }
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
  return {
    stagedRequests,
    lastTargetReadyAt: () => {
      const last = stagedRequests[stagedRequests.length - 1]
      return last ? last.schedule_request.device_config.target_ready_at : null
    },
  }
}

/** Walk the manual flow up to (and including) the kitchen step. */
async function openKitchen() {
  const App = (await import('./App')).default
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /手动精确配置/ }))
  for (const name of NAMES) {
    // Recipe titles also appear inside other copy, so click the card itself.
    const card = screen.getByText(name, { selector: '.recipe-card strong', exact: true }).closest('button')
    expect(card).not.toBeNull()
    fireEvent.click(card!)
  }
  fireEvent.click(screen.getByRole('button', { name: /下一步：配置厨房/ }))
  await screen.findByText('告诉我你的厨房现在有什么')
}

/** Mock mode only knows the bundled demo catalog, so use its real recipe names. */
async function openKitchenMock() {
  const { recipeCatalog } = await import('./mock/recipes')
  const App = (await import('./App')).default
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /手动精确配置/ }))
  for (const recipe of recipeCatalog.slice(0, 3)) {
    const card = screen.getByText(recipe.name, { selector: '.recipe-card strong', exact: true }).closest('button')
    expect(card).not.toBeNull()
    fireEvent.click(card!)
  }
  fireEvent.click(screen.getByRole('button', { name: /下一步：配置厨房/ }))
  await screen.findByText('告诉我你的厨房现在有什么')
}

async function confirmAndSchedule() {
  fireEvent.click(screen.getByRole('button', { name: /下一步：解析确认/ }))
  await screen.findByText('确认菜谱解析结果')
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  fireEvent.click(screen.getByRole('button', { name: /生成初始排程/ }))
  return within(await screen.findByRole('region', { name: '排程结果确认' }))
}

function dateInput() { return screen.getByLabelText('希望哪天开饭') }
function timeInput() { return screen.getByLabelText('希望几点开饭') }

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(FIXED_NOW) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

// ---------------------------------------------------------------------------
// 1. 只选择今天且时间在未来
// ---------------------------------------------------------------------------
it('1) accepts today when the chosen time is still in the future', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  const harness = installHarness()
  await openKitchen()

  expect(dateInput()).toHaveValue('2026-10-09')
  // The picker itself refuses days that are already gone …
  expect(dateInput()).toHaveAttribute('min', '2026-10-09')
  // … while today, tomorrow and any later day stay selectable.
  expect((dateInput() as HTMLInputElement).min).toBe('2026-10-09')

  fireEvent.change(timeInput(), { target: { value: '12:30' } })
  fireEvent.click(screen.getByRole('button', { name: /下一步：解析确认/ }))
  await screen.findByText('确认菜谱解析结果')

  fireEvent.click(screen.getAllByRole('checkbox')[0])
  fireEvent.click(screen.getByRole('button', { name: /生成初始排程/ }))
  await screen.findByRole('region', { name: '排程结果确认' })

  const sent = new Date(harness.lastTargetReadyAt()!)
  expect([sent.getFullYear(), sent.getMonth() + 1, sent.getDate(), sent.getHours(), sent.getMinutes()])
    .toEqual([2026, 10, 9, 12, 30])
})

// ---------------------------------------------------------------------------
// 2. 选择明天 12:30
// ---------------------------------------------------------------------------
it('2) accepts tomorrow 12:30 and sends that exact day', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  const harness = installHarness()
  await openKitchen()

  fireEvent.click(screen.getByRole('button', { name: '明天' }))
  expect(dateInput()).toHaveValue('2026-10-10')
  // The card states the distance in words so the chosen day is never ambiguous.
  expect(screen.getByText('明天', { selector: '.target-day-note' })).toBeInTheDocument()

  const result = await confirmAndSchedule()
  const sent = new Date(harness.lastTargetReadyAt()!)
  expect([sent.getMonth() + 1, sent.getDate(), sent.getHours(), sent.getMinutes()]).toEqual([10, 10, 12, 30])
  // P3 shows the day the user picked, not just a clock time.
  expect(result.getByText('10月10日 12:30')).toBeInTheDocument()
})

// ---------------------------------------------------------------------------
// 3. 选择三天后的 12:30
// ---------------------------------------------------------------------------
it('3) accepts a date three days out via the date picker', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  const harness = installHarness()
  await openKitchen()

  fireEvent.change(dateInput(), { target: { value: '2026-10-12' } })
  expect(dateInput()).toHaveValue('2026-10-12')
  expect(screen.getByText('3 天后')).toBeInTheDocument()

  const result = await confirmAndSchedule()
  const sent = new Date(harness.lastTargetReadyAt()!)
  expect([sent.getMonth() + 1, sent.getDate(), sent.getHours(), sent.getMinutes()]).toEqual([10, 12, 12, 30])
  expect(result.getByText('10月12日 12:30')).toBeInTheDocument()
})

// ---------------------------------------------------------------------------
// 4. 选择已经过去的日期时间
// ---------------------------------------------------------------------------
it('4) refuses an already-passed date and never silently moves it forward', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  const harness = installHarness()
  await openKitchen()

  fireEvent.change(dateInput(), { target: { value: '2026-10-08' } })
  const warning = await screen.findByRole('alert')
  expect(warning).toHaveTextContent('已经过去')
  expect(screen.getByRole('button', { name: /下一步：解析确认/ })).toBeDisabled()

  // The date the user typed is preserved rather than auto-corrected.
  expect(dateInput()).toHaveValue('2026-10-08')
  expect(harness.stagedRequests).toHaveLength(0)

  // Choosing a valid day clears the block.
  fireEvent.click(screen.getByRole('button', { name: '明天' }))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /下一步：解析确认/ })).toBeEnabled()
})

it('4b) refuses a same-day time that has already passed', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  installHarness()
  await openKitchen()

  fireEvent.change(timeInput(), { target: { value: '08:00' } })
  expect(await screen.findByRole('alert')).toHaveTextContent('已经过去')
  expect(screen.getByRole('button', { name: /下一步：解析确认/ })).toBeDisabled()
})

// ---------------------------------------------------------------------------
// 5 + 6. 提前准备跨天 / 24 小时冷冻计入整体历时
// ---------------------------------------------------------------------------
it('5+6) keeps a 24-hour cold hold inside the overall elapsed time and shows it separately', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  const harness = installHarness({ withAdvance: true })
  await openKitchen()

  fireEvent.click(screen.getByRole('button', { name: '明天' }))
  const result = await confirmAndSchedule()

  // The choice is unhurried: the freeze does not shrink to fit a same-day target.
  const sent = new Date(harness.lastTargetReadyAt()!)
  expect([sent.getMonth() + 1, sent.getDate(), sent.getHours(), sent.getMinutes()]).toEqual([10, 10, 12, 30])

  expect(result.getByText('整体总历时（含提前准备）')).toBeInTheDocument()
  expect(result.getByText('24 小时 13 分钟')).toBeInTheDocument()
  const staged = within(result.getByLabelText('分阶段排程指标'))
  expect(staged.getByText('24 小时')).toBeInTheDocument()
  expect(staged.getByText('13 分钟')).toBeInTheDocument()

  const advance = within(result.getByRole('region', { name: '提前准备计划' }))
  expect(advance.getByText('提前冷冻24小时')).toBeInTheDocument()
  expect(advance.getByText('预计需要 24 小时')).toBeInTheDocument()
})

// ---------------------------------------------------------------------------
// 7. P3 时间与用户选择的日期一致
// ---------------------------------------------------------------------------
it('7) shows the chosen date on the result page for several different days', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  const harness = installHarness()
  await openKitchen()

  fireEvent.change(dateInput(), { target: { value: '2026-10-15' } })
  const result = await confirmAndSchedule()

  expect(result.getByText('目标开饭')).toBeInTheDocument()
  expect(result.getAllByText(/10月15日 12:30/).length).toBeGreaterThan(0)
  // The suggested start is derived from the same deadline, so it stays in October.
  expect(result.getByText(/10月15日 12:17/)).toBeInTheDocument()
  expect(new Date(harness.lastTargetReadyAt()!).getDate()).toBe(15)
})

it('7b) warns and blocks start when the suggested advance start has already passed', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  // Freeze was supposed to begin yesterday; the plan cannot be met any more.
  installHarness({ withAdvance: true, advanceStart: '2026-10-08T12:30:00.000Z' })
  await openKitchen()

  fireEvent.click(screen.getByRole('button', { name: '明天' }))
  const result = await confirmAndSchedule()

  expect(result.getByRole('status')).toHaveTextContent('提前准备开始时间已经过去')
  // The UI never assumes the work was done for the user.
  expect(result.getByRole('button', { name: '开始做饭 →' })).toBeDisabled()
})

// ---------------------------------------------------------------------------
// 8. 无提前准备的普通菜谱
// ---------------------------------------------------------------------------
it('8) shows a single-phase summary for a recipe with no advance preparation', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  installHarness()
  await openKitchen()

  fireEvent.click(screen.getByRole('button', { name: '明天' }))
  const result = await confirmAndSchedule()

  expect(result.getByText('预计总用时')).toBeInTheDocument()
  expect(result.queryByText('整体总历时（含提前准备）')).not.toBeInTheDocument()
  expect(result.queryByRole('region', { name: '提前准备计划' })).not.toBeInTheDocument()
  expect(result.getByRole('button', { name: '开始做饭 →' })).toBeEnabled()
})

// ---------------------------------------------------------------------------
// 9 + 10. 提前准备确认门禁
// ---------------------------------------------------------------------------
it('9+10) blocks main execution until every advance task is confirmed, then allows it', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  const harness = installHarness({ withAdvance: true })
  await openKitchen()

  fireEvent.click(screen.getByRole('button', { name: '明天' }))
  const result = await confirmAndSchedule()

  expect(result.getByRole('button', { name: '开始做饭 →' })).toBeDisabled()
  const confirm = result.getByRole('button', { name: /确认 1 项提前准备已实际完成/ })
  expect(confirm).toBeDisabled()

  // A partially ticked list still cannot confirm.
  fireEvent.click(result.getByRole('checkbox'))
  expect(confirm).toBeEnabled()
  fireEvent.click(confirm)

  await screen.findByText('全部提前准备已确认，可以开始正式烹饪')
  expect(harness.stagedRequests).toHaveLength(2)
  expect(harness.stagedRequests[1].confirmed_advance_task_ids).toEqual([ADVANCE_ID])
  expect(result.getByRole('button', { name: '开始做饭 →' })).toBeEnabled()

  fireEvent.click(result.getByRole('button', { name: '开始做饭 →' }))
  expect(await screen.findByText('接下来做什么')).toBeInTheDocument()
})

// ---------------------------------------------------------------------------
// 11. Mock 模式兼容
// ---------------------------------------------------------------------------
it('11) keeps the Mock mode flow working with an explicit date', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  await openKitchenMock()

  fireEvent.click(screen.getByRole('button', { name: '明天' }))
  fireEvent.click(screen.getByRole('button', { name: /下一步：解析确认/ }))
  await screen.findByText('确认菜谱解析结果')
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  fireEvent.click(screen.getByRole('button', { name: /生成初始排程/ }))
  await screen.findByText('排程已生成')

  // Mock mode must not touch the network.
  expect(fetcher).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '开始做饭 →' })).toBeEnabled()
})

it('11b) Mock mode still rejects an already-passed deadline', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  vi.stubGlobal('fetch', vi.fn())
  await openKitchenMock()

  fireEvent.change(dateInput(), { target: { value: '2026-10-01' } })
  expect(await screen.findByRole('alert')).toHaveTextContent('已经过去')
  expect(screen.getByRole('button', { name: /下一步：解析确认/ })).toBeDisabled()
})

// ---------------------------------------------------------------------------
// 12. Agent 功能不受影响
// ---------------------------------------------------------------------------
it('12) carries the explicit date through confirmation and into the execution view', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  const harness = installHarness()
  await openKitchen()

  fireEvent.change(dateInput(), { target: { value: '2026-10-11' } })
  fireEvent.change(timeInput(), { target: { value: '18:30' } })
  fireEvent.click(screen.getByRole('button', { name: /下一步：解析确认/ }))
  await screen.findByText('确认菜谱解析结果')

  // The confirmation sidebar states the full deadline, not a bare clock time.
  expect(screen.getByText('10月11日 18:30')).toBeInTheDocument()

  fireEvent.click(screen.getAllByRole('checkbox')[0])
  fireEvent.click(screen.getByRole('button', { name: /生成初始排程/ }))
  const result = within(await screen.findByRole('region', { name: '排程结果确认' }))
  expect(result.getAllByText(/10月11日 18:30/).length).toBeGreaterThan(0)

  fireEvent.click(result.getByRole('button', { name: '开始做饭 →' }))
  expect(await screen.findByText('接下来做什么')).toBeInTheDocument()

  const sent = new Date(harness.lastTargetReadyAt()!)
  expect([sent.getMonth() + 1, sent.getDate(), sent.getHours(), sent.getMinutes()]).toEqual([10, 11, 18, 30])
})

// ---------------------------------------------------------------------------
// 状态持久化：用户显式选择的日期不得被刷新或迁移逻辑改掉
// ---------------------------------------------------------------------------
it('keeps the user-chosen date across a page refresh', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  vi.stubGlobal('fetch', vi.fn())

  let App = (await import('./App')).default
  const first = render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /手动精确配置/ }))
  const { recipeCatalog } = await import('./mock/recipes')
  for (const recipe of recipeCatalog.slice(0, 3)) {
    const card = screen.getByText(recipe.name, { selector: '.recipe-card strong', exact: true }).closest('button')
    fireEvent.click(card!)
  }
  fireEvent.click(screen.getByRole('button', { name: /下一步：配置厨房/ }))
  await screen.findByText('告诉我你的厨房现在有什么')

  fireEvent.change(dateInput(), { target: { value: '2026-10-14' } })
  fireEvent.change(timeInput(), { target: { value: '19:00' } })
  expect(JSON.parse(localStorage.getItem('cookflow.session.v1')!).kitchen.target_date).toBe('2026-10-14')
  first.unmount()

  // A reload must restore the exact day, not reset it to today.
  vi.resetModules()
  App = (await import('./App')).default
  render(<App />)
  await screen.findByText('告诉我你的厨房现在有什么')
  expect(dateInput()).toHaveValue('2026-10-14')
  expect(timeInput()).toHaveValue('19:00')
  expect(screen.getByText('5 天后')).toBeInTheDocument()
})

it('migrates a session saved before the date picker existed', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  vi.stubGlobal('fetch', vi.fn())
  // Legacy shape: a clock time and no `target_date` at all. 08:00 has already
  // passed at the pinned 09:00, which the legacy code would have silently
  // rolled to tomorrow.
  localStorage.setItem('cookflow.session.v1', JSON.stringify({
    planningMode: 'manual',
    planSource: 'manual',
    manualFlow: true,
    step: 'kitchen',
    selectedIds: [],
    kitchen: { target_time: '08:00', operator_count: 1, stove_count: 1, steamer_count: 1, oven_count: 1 },
    parsed: [],
    confirmed: false,
    schedule: null,
    executionStarted: false,
    stagedPlan: null,
    stagedRequest: null,
  }))

  const App = (await import('./App')).default
  render(<App />)
  await screen.findByText('告诉我你的厨房现在有什么')

  // The day is filled in so the picker is never blank, and the clock is untouched.
  expect(dateInput()).toHaveValue('2026-10-09')
  expect(timeInput()).toHaveValue('08:00')
  // The legacy silent roll-forward is gone: the user must resolve it.
  expect(await screen.findByRole('alert')).toHaveTextContent('已经过去')
  expect(screen.getByRole('button', { name: /下一步：解析确认/ })).toBeDisabled()
})

it('accepts a legacy session whose clock time is still ahead today', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  vi.stubGlobal('fetch', vi.fn())
  localStorage.setItem('cookflow.session.v1', JSON.stringify({
    planningMode: 'manual',
    planSource: 'manual',
    manualFlow: true,
    step: 'kitchen',
    selectedIds: [],
    kitchen: { target_time: '18:30', operator_count: 1, stove_count: 1, steamer_count: 1, oven_count: 1 },
    parsed: [],
    confirmed: false,
    schedule: null,
    executionStarted: false,
    stagedPlan: null,
    stagedRequest: null,
  }))

  const App = (await import('./App')).default
  render(<App />)
  await screen.findByText('告诉我你的厨房现在有什么')

  expect(dateInput()).toHaveValue('2026-10-09')
  expect(timeInput()).toHaveValue('18:30')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /下一步：解析确认/ })).toBeEnabled()
})

it('rejects a forged past date in a restored session instead of trusting it', async () => {
  vi.stubEnv('VITE_API_MODE', 'mock')
  vi.stubGlobal('fetch', vi.fn())
  localStorage.setItem('cookflow.session.v1', JSON.stringify({
    planningMode: 'manual',
    planSource: 'manual',
    manualFlow: true,
    step: 'kitchen',
    selectedIds: [],
    kitchen: { target_date: '2026-10-01', target_time: '12:30', operator_count: 1, stove_count: 1, steamer_count: 1, oven_count: 1 },
    parsed: [],
    confirmed: false,
    schedule: null,
    executionStarted: false,
    stagedPlan: null,
    stagedRequest: null,
  }))

  const App = (await import('./App')).default
  render(<App />)
  await screen.findByText('告诉我你的厨房现在有什么')

  // The stored day is preserved for the user to inspect and fix …
  expect(dateInput()).toHaveValue('2026-10-01')
  // … but it can never silently produce a plan.
  expect(await screen.findByRole('alert')).toHaveTextContent('已经过去')
  expect(screen.getByRole('button', { name: /下一步：解析确认/ })).toBeDisabled()
})
