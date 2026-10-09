import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductApi, ProductApiError, buildDeviceConfig, resourceLabel, resourceTone } from './product'
import type { ParseResult } from './product'
import requestExample from '../../../contracts/v1/examples/schedule-request-v1.json'
import responseExample from '../../../contracts/v1/examples/schedule-response-v1.json'

const kitchen = { target_time: '12:30', operator_count: 2, stove_count: 2, steamer_count: 1, oven_count: 0 }
const ids = ['r1', 'r2', 'r3']
const parsed: ParseResult[] = ids.map(recipe_id => ({ schema_version: '1.0', recipe_id, provider: 'deterministic', tasks: [{ ...requestExample.tasks[0], task_id: `${recipe_id}_t`, dish_id: recipe_id, predecessors: [] }] } as ParseResult))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('product API', () => {
  it('maps official catalog summaries without invented recipe steps', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ recipes: [{ recipe_id: 'r1', name: '鱼', step_count: 4, ingredient_count: 2 }] }))
    vi.stubGlobal('fetch', fetcher)
    expect((await new ProductApi('http://api/').listRecipes())[0]).toMatchObject({ preview: '2 种食材', step_count: 4 })
    expect(fetcher.mock.calls[0][0]).toBe('http://api/recipes')
  })
  it('loads detail before parsing and forwards the complete recipe', async () => {
    const recipe = { schema_version: '1.0', recipe_id: 'r/a', name: '鱼', ingredients: ['鱼'], steps_text: ['蒸10分钟'], source: 'official' }
    const fetcher = vi.fn().mockResolvedValueOnce(json(recipe)).mockResolvedValueOnce(json(parsed[0]))
    vi.stubGlobal('fetch', fetcher)
    const api = new ProductApi('http://api')
    await api.parseRecipe(await api.getRecipe('r/a'))
    expect(fetcher.mock.calls[0][0]).toBe('http://api/recipes/r%2Fa')
    expect(fetcher.mock.calls[1][0]).toBe('http://api/recipes/parse')
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(recipe)
  })
  it('keeps each recipe task graph when parsing a selection', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => url.endsWith('/parse')
      ? json(parsed.find(result => result.recipe_id === JSON.parse(String(init?.body)).recipe_id))
      : json({ recipe_id: url.substring(url.lastIndexOf('/') + 1) }))
    vi.stubGlobal('fetch', fetcher)
    expect(await new ProductApi('http://api').parseSelection(ids)).toEqual(parsed)
    expect(fetcher).toHaveBeenCalledTimes(6)
  })
  it('validates device_config then sends a V1 request, preserving task provenance', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ valid: true, errors: [] })).mockResolvedValueOnce(json(responseExample))
    vi.stubGlobal('fetch', fetcher)
    const result = await new ProductApi('http://api').createSchedule(ids, kitchen, parsed)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['http://api/devices/validate', 'http://api/schedules'])
    const body = JSON.parse(fetcher.mock.calls[1][1].body)
    expect(Object.keys(body).sort()).toEqual(['device_config', 'request_id', 'schema_version', 'tasks'])
    expect(body.tasks).toEqual(parsed.flatMap(result => result.tasks))
    expect(body).not.toHaveProperty('recipe_ids')
    expect(body.device_config).not.toHaveProperty('stove_count')
    expect(result.schedule.schedule_id).toBe(responseExample.schedule_id)
  })
  it('blocks schedules when device validation returns HTTP 200 with valid=false', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ valid: false, errors: [{ code: 'INVALID_INPUT', message: 'bad device' }] }))
    vi.stubGlobal('fetch', fetcher)
    await expect(new ProductApi().createSchedule(ids, kitchen, parsed)).rejects.toThrow('厨房设备配置未通过校验')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([422, 409, 504])('preserves structured HTTP %i errors without mock fallback', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: { code: 'BACKEND_CODE', message: 'backend message', details: [{ code: 'DETAIL', message: 'detail', path: 'tasks' }] } }, status)))
    await expect(new ProductApi().listRecipes()).rejects.toMatchObject({ status, code: 'BACKEND_CODE', details: [{ code: 'DETAIL', message: 'detail', path: 'tasks' }] })
  })
  it('reports offline and invalid JSON failures', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(new Response('html', { status: 502 }))
    vi.stubGlobal('fetch', fetcher)
    const api = new ProductApi()
    await expect(api.listRecipes()).rejects.toThrow('offline')
    await expect(api.listRecipes()).rejects.toBeInstanceOf(ProductApiError)
  })
  it('blocks stale parsing, missing fields and invalid selection before any request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const api = new ProductApi()
    await expect(api.createSchedule(ids, kitchen, parsed.slice(1))).rejects.toThrow('重新解析')
    await expect(api.parseSelection(['r1', 'r1', 'r2'])).rejects.toThrow('不同的菜')
    const missing = structuredClone(parsed); missing[0].tasks[0].field_status = { duration_sec: 'missing' }
    await expect(api.createSchedule(ids, kitchen, missing)).rejects.toThrow('缺失字段')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('resource labeling', () => {
  it('maps resource ids to Chinese labels with zero-padded indexes', () => {
    expect(resourceLabel('operator_1')).toBe('操作员 · 01')
    expect(resourceLabel('stove_2')).toBe('灶具 · 02')
    expect(resourceLabel('steamer_1')).toBe('蒸箱 · 01')
    expect(resourceLabel('range_hood_3')).toBe('烟机 · 03')
  })
  it('keeps the raw type for unknown ids and omits the index when there is none', () => {
    expect(resourceLabel('unknown_7')).toBe('unknown · 07')
    expect(resourceLabel('oven')).toBe('烤箱')
    expect(resourceLabel('operator')).toBe('操作员')
  })
  it('assigns a stable tone per resource type and a fallback tone for unknown types', () => {
    expect(resourceTone('operator_1', 0)).toBe('gold')
    expect(resourceTone('stove_1', 1)).toBe('cyan')
    expect(resourceTone('steamer_1', 2)).toBe('violet')
    expect(resourceTone('oven_1', 3)).toBe('slate')
    expect(resourceTone('unknown_1', 0)).toBe('gold')
    expect(resourceTone('unknown_1', 1)).toBe('cyan')
  })
})

describe('device configuration', () => {
  it('creates independent burners and an absolute timezone-bearing target', () => {
    const now = new Date(2026, 9, 4, 13, 0)
    const config = buildDeviceConfig(kitchen, now)
    expect(config.devices.map(device => device.device_id)).toEqual(['stove_1', 'stove_2', 'steamer_1'])
    const target = new Date(config.target_ready_at)
    expect(target.getDate()).toBe(5); expect(target.getHours()).toBe(12); expect(target.getMinutes()).toBe(30)
    expect(config.target_ready_at).toMatch(/Z$/)
  })
  it.each([{ stove_count: -1 }, { steamer_count: 1.5 }, { operator_count: 0 }, { target_time: '25:00' }])('rejects invalid input %o', change => {
    expect(() => buildDeviceConfig({ ...kitchen, ...change })).toThrow()
  })
})

describe('explicit dinner date', () => {
  const now = new Date(2026, 9, 9, 9, 0) // 2026-10-09 09:00 local

  it('honours today when the chosen time is still ahead', () => {
    const config = buildDeviceConfig({ ...kitchen, target_date: '2026-10-09', target_time: '12:30' }, now)
    const target = new Date(config.target_ready_at)
    expect(target.getDate()).toBe(9)
    expect(target.getHours()).toBe(12)
    expect(target.getMinutes()).toBe(30)
  })

  it('honours tomorrow 12:30 instead of inferring it from the clock', () => {
    const config = buildDeviceConfig({ ...kitchen, target_date: '2026-10-10', target_time: '12:30' }, now)
    const target = new Date(config.target_ready_at)
    expect(target.getMonth()).toBe(9)
    expect(target.getDate()).toBe(10)
    expect(target.getHours()).toBe(12)
  })

  it('honours a date three days out', () => {
    const config = buildDeviceConfig({ ...kitchen, target_date: '2026-10-12', target_time: '12:30' }, now)
    const target = new Date(config.target_ready_at)
    expect(target.getDate()).toBe(12)
    expect(target.getHours()).toBe(12)
  })

  it('never silently rolls an already-passed choice forward to tomorrow', () => {
    // The legacy behaviour would have produced 2026-10-10 here; the explicit
    // date must instead fail loudly so the user resolves it.
    expect(() => buildDeviceConfig({ ...kitchen, target_date: '2026-10-08', target_time: '12:30' }, now)).toThrow(/已经过去/)
    expect(() => buildDeviceConfig({ ...kitchen, target_date: '2026-10-09', target_time: '08:00' }, now)).toThrow(/已经过去/)
  })

  it('rejects a malformed date rather than guessing', () => {
    expect(() => buildDeviceConfig({ ...kitchen, target_date: '2026/10/11', target_time: '12:30' }, now)).toThrow(/有效的开饭日期/)
    expect(() => buildDeviceConfig({ ...kitchen, target_date: '2026-02-30', target_time: '12:30' }, now)).toThrow()
  })

  it('keeps the legacy clock-only behaviour for Agent drafts and old sessions', () => {
    // `target_date` absent -> today, or tomorrow once today's time has passed.
    expect(new Date(buildDeviceConfig({ ...kitchen, target_time: '12:30' }, now).target_ready_at).getDate()).toBe(9)
    expect(new Date(buildDeviceConfig({ ...kitchen, target_time: '08:00' }, now).target_ready_at).getDate()).toBe(10)
  })

  it('round-trips the same local wall clock it was given, day included', () => {
    const config = buildDeviceConfig({ ...kitchen, target_date: '2026-10-11', target_time: '12:30' }, now)
    const target = new Date(config.target_ready_at)
    // The instant is absolute, but the local fields must match the selection.
    expect([target.getFullYear(), target.getMonth() + 1, target.getDate(), target.getHours(), target.getMinutes()])
      .toEqual([2026, 10, 11, 12, 30])
  })
})

describe('parser provider', () => {
  it('adds the llm provider only when AI parsing is selected', async () => {
    const fetcher = vi.fn(async (url: string) => json({ schema_version: '1.0', recipe_id: 'r1', provider: 'llm', tasks: [] }))
    vi.stubGlobal('fetch', fetcher)
    await new ProductApi('http://api').parseRecipe({ schema_version: '1.0', recipe_id: 'r1', name: '鱼', ingredients: ['鱼'], steps_text: ['蒸鱼'] }, 'llm')
    expect(fetcher.mock.calls[0][0]).toBe('http://api/recipes/parse?provider=llm')
  })
})

describe('model settings', () => {
  it('loads, updates and probes configuration without putting the key in a URL', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const parsedUrl = new URL(url)
      if (parsedUrl.pathname === '/settings/model' && !init?.method) return new Response(JSON.stringify({ parser_provider: 'deterministic', configured: false, ready: false, base_url: null, model: 'gpt-4o-mini', api_key_masked: null, source: 'runtime', notes: [] }), { status: 200 })
      if (parsedUrl.pathname === '/settings/model' && init?.method === 'PUT') return new Response(JSON.stringify({ parser_provider: 'llm', configured: true, ready: true, base_url: 'https://model.test/v1', model: 'cook-model', api_key_masked: 'sk-s********1234', source: 'runtime', notes: [] }), { status: 200 })
      if (parsedUrl.pathname === '/settings/model/test') return new Response(JSON.stringify({ ok: true, model: 'cook-model', base_url: 'https://model.test/v1', message: '连接成功' }), { status: 200 })
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const api = new ProductApi('http://api.test')
    expect((await api.getModelSettings()).parser_provider).toBe('deterministic')
    await api.updateModelSettings({ parser_provider: 'llm', base_url: 'https://model.test/v1', model: 'cook-model', api_key: 'sk-secret' })
    expect((await api.testModelSettings({ base_url: 'https://model.test/v1', model: 'cook-model', api_key: 'sk-secret' })).ok).toBe(true)
    expect(fetcher.mock.calls.every(([url]) => !String(url).includes('sk-secret'))).toBe(true)
  })
})
