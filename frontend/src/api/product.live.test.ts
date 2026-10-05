// @vitest-environment node
import { expect, it } from 'vitest'
import { ProductApi, buildDeviceConfig } from './product'
import { HttpCookFlowApi } from './client'
import type { ParseResult } from './product'

// Optional real-backend smoke test, never substitutes for the default isolated tests.
const liveUrl = import.meta.env.VITE_PRODUCT_LIVE_API_URL
it.skipIf(!liveUrl).each([3, 5])('official %i recipes → parse → device validation → real initial schedule', async count => {
  const api = new ProductApi(liveUrl)
  const kitchen = { target_time: '23:30', operator_count: 1, stove_count: 2, steamer_count: 1, oven_count: 1, refrigerator_count: 1, dishwasher_count: 1, range_hood_count: 1, water_purifier_count: 1 }
  const config = buildDeviceConfig(kitchen)
  const catalog = await api.listRecipes()
  expect(catalog.length).toBeGreaterThanOrEqual(3)
  const parsed: ParseResult[] = []
  for (const recipe of catalog) {
    const result = await api.parseRecipe(await api.getRecipe(recipe.recipe_id))
    const compatible = result.tasks.length > 0 && result.tasks.every(task => {
      if (Object.values(task.field_status ?? {}).includes('missing')) return false
      const req = task.device_requirement
      return !req || config.devices.some(device => device.device_type === req.device_type
        && device.capacity_units >= req.capacity_units
        && (!req.mode || device.capabilities.modes.includes(req.mode))
        && (req.temperature_c == null || (device.capabilities.temperature_min_c == null || req.temperature_c >= device.capabilities.temperature_min_c) && (device.capabilities.temperature_max_c == null || req.temperature_c <= device.capabilities.temperature_max_c)))
    })
    if (compatible) parsed.push(result)
    if (parsed.length === count) break
  }
  expect(parsed).toHaveLength(count)
  const result = await api.createSchedule(parsed.map(item => item.recipe_id), kitchen, parsed)
  expect(result.schedule.validation.valid).toBe(true)
  expect(['OPTIMAL', 'FEASIBLE']).toContain(result.schedule.solver.status)
  expect(result.schedule.metrics.device_conflicts).toBe(0)
  expect(result.schedule.metrics.dependency_violations).toBe(0)
  expect(result.schedule.tasks).toHaveLength(parsed.flatMap(item => item.tasks).length)
  expect(result.schedule.tasks.every(task => parsed.some(item => item.tasks.some(input => input.task_id === task.task_id && input.action === task.action)))).toBe(true)
  const execution = new HttpCookFlowApi(liveUrl)
  execution.setScheduleRequest({ ...result.request })
  const pending = result.schedule.tasks.find(task => task.status === 'PENDING' && !task.locked)!
  expect(pending).toBeDefined()
  const started = await execution.postEvent(pending, 'RUNNING', result.schedule)
  const running = started.schedule.tasks.find(task => task.task_id === pending.task_id)!
  const delayed = await execution.postEvent(running, 'DELAYED', started.schedule)
  expect(delayed.schedule.validation.valid).toBe(true)
  expect(['OPTIMAL', 'FEASIBLE']).toContain(delayed.schedule.solver.status)
  expect(delayed.schedule.metrics.device_conflicts).toBe(0)
  expect(delayed.schedule.metrics.dependency_violations).toBe(0)
  expect(delayed.schedule.request_id).toBe(result.request.request_id)
  expect([...new Set(delayed.schedule.tasks.map(task => task.dish_id))].sort()).toEqual(parsed.map(item => item.recipe_id).sort())
  console.info('replan', JSON.stringify({ recipe_ids: parsed.map(item => item.recipe_id), status: delayed.schedule.solver.status, metrics: delayed.schedule.metrics }))
  console.info(JSON.stringify({ recipe_ids: parsed.map(item => item.recipe_id), task_count: result.schedule.tasks.length, solver: result.schedule.solver.status, metrics: result.schedule.metrics }))
}, 120000)
