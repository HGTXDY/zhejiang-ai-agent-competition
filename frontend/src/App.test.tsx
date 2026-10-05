import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  for (const name of names) fireEvent.click(await screen.findByRole('button', { name: new RegExp(name) }))
  fireEvent.click(screen.getByRole('button', { name: /下一步：配置厨房/ }))
  await screen.findByText('告诉我你的厨房现在有什么')
  fireEvent.click(screen.getByRole('button', { name: /下一步：解析确认/ }))
  await screen.findByText('确认菜谱解析结果')
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: /生成初始排程/ }))
  await screen.findByText('任务队列')
}

it('HTTP: real non-Demo selection flows into ExecutionDashboard and delayed replan with the identical request', async () => {
  vi.stubEnv('VITE_API_MODE', 'http')
  let initialRequest: any
  let replanEnvelope: any
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://test').pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path === '/recipes') return json({ recipes: ids.map((id, index) => ({ recipe_id: id, name: `真实菜${index}`, step_count: 1, ingredient_count: 1 })) })
    if (path.startsWith('/recipes/') && path !== '/recipes/parse') return json({ schema_version: '1.0', recipe_id: path.split('/').pop(), name: '真实菜', ingredients: ['食材'], steps_text: ['备料一分钟'] })
    if (path === '/recipes/parse') return json({ schema_version: '1.0', recipe_id: body.recipe_id, provider: 'deterministic', tasks: tasks.filter(task => task.dish_id === body.recipe_id) })
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
  fireEvent.click(screen.getByRole('button', { name: /review_real_a_prepare/ }))
  fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
  fireEvent.click(await screen.findByRole('button', { name: '上报延迟' }))
  await waitFor(() => expect(replanEnvelope).toBeDefined())
  expect(initialRequest.tasks.map((task: any) => task.dish_id)).toEqual(ids)
  expect(replanEnvelope.schedule_request).toEqual(initialRequest)
  expect(replanEnvelope.event.event_type).toBe('TASK_DELAYED')
  expect(replanEnvelope.current_schedule).not.toHaveProperty('resources')
  expect(fetcher.mock.calls.some(([url]) => url.includes('/demo/'))).toBe(false)
  for (const endpoint of ['/recipes', '/recipes/parse', '/devices/validate', '/schedules', '/v1/replans']) expect(fetcher.mock.calls.some(([url]) => new URL(url).pathname === endpoint)).toBe(true)
})

it.each(['mock', undefined])('Mock (%s): completes selection, kitchen, confirmation and selected-dish results without any backend fetch', async mode => {
  vi.stubEnv('VITE_API_MODE', mode)
  const fetcher = vi.fn().mockRejectedValue(new Error('Backend must not be requested'))
  vi.stubGlobal('fetch', fetcher)
  const App = (await import('./App')).default
  render(<App />)
  await screen.findByText(/MOCK API/)
  await flow(recipeCatalog.slice(0, 3).map(recipe => recipe.name))
  for (const recipe of recipeCatalog.slice(0, 3)) expect(screen.getByRole('button', { name: new RegExp(`${recipe.recipe_id}_prepare`) })).toBeInTheDocument()
  expect(fetcher).not.toHaveBeenCalled()
})
