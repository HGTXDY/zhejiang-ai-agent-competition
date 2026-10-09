// @vitest-environment node
/**
 * Optional real-backend smoke test for the Fix 05 staged flow and the explicit
 * dinner date. Needs a backend that serves `POST /schedules/staged`
 * (PR #79 / the Fix04 branch) plus the regression suite.
 *
 * Run with:  VITE_PRODUCT_LIVE_API_URL=http://127.0.0.1:8013 npx vitest run src/api/staged.live.test.ts
 * It is skipped automatically when the variable is absent, so `npm test` stays offline.
 */
import { expect, it } from 'vitest'
import { ProductApi, buildDeviceConfig } from './product'
import type { ParseResult } from './product'

const liveUrl = import.meta.env.VITE_PRODUCT_LIVE_API_URL

/** The kitchen moment under test: a full local date plus time. */
const TARGET_DATE = '2026-11-20'
const TARGET_TIME = '18:30'

it.skipIf(!liveUrl)('explicit dinner date reaches the real staged scheduler and round-trips', async () => {
  const api = new ProductApi(liveUrl)
  const kitchen = {
    target_date: TARGET_DATE,
    target_time: TARGET_TIME,
    operator_count: 1,
    stove_count: 2, steamer_count: 1, oven_count: 1, refrigerator_count: 1,
    dishwasher_count: 1, range_hood_count: 1, water_purifier_count: 1,
  }
  const config = buildDeviceConfig(kitchen)

  // The deadline must be the exact local instant that was chosen.
  const sent = new Date(config.target_ready_at)
  expect([sent.getFullYear(), sent.getMonth() + 1, sent.getDate(), sent.getHours(), sent.getMinutes()])
    .toEqual([2026, 11, 20, 18, 30])

  const catalog = await api.listRecipes()
  const parsed: ParseResult[] = []
  for (const recipe of catalog) {
    const result = await api.parseRecipe(await api.getRecipe(recipe.recipe_id))
    const compatible = result.tasks.length > 0 && result.tasks.every(task => {
      if (Object.values(task.field_status ?? {}).includes('missing')) return false
      const req = task.device_requirement
      return !req || config.devices.some(device => device.device_type === req.device_type
        && device.capacity_units >= req.capacity_units
        && (!req.mode || device.capabilities.modes.includes(req.mode))
        && (req.temperature_c == null || ((device.capabilities.temperature_min_c == null || req.temperature_c >= device.capabilities.temperature_min_c) && (device.capabilities.temperature_max_c == null || req.temperature_c <= device.capabilities.temperature_max_c))))
    })
    if (compatible) parsed.push(result)
    if (parsed.length === 3) break
  }
  expect(parsed).toHaveLength(3)

  const ids = parsed.map(item => item.recipe_id)
  const staged = await api.createStagedSchedule(ids, kitchen, parsed)

  // The backend echoes the deadline unchanged and never invents a different day.
  const echoed = staged.plan.timing.target_ready_at
  expect(echoed).not.toBeNull()
  const planTarget = new Date(echoed!)
  expect([planTarget.getMonth() + 1, planTarget.getDate(), planTarget.getHours(), planTarget.getMinutes()])
    .toEqual([11, 20, 18, 30])

  // Timing stays internally consistent, and any cold hold stays inside the total.
  const timing = staged.plan.timing
  expect(timing.total_elapsed_sec).toBe(timing.advance_makespan_sec + timing.main_makespan_sec)
  expect(timing.main_makespan_sec).toBe(staged.plan.main_schedule.metrics.makespan_sec)
  expect(staged.plan.main_schedule.validation.valid).toBe(true)
  expect(['OPTIMAL', 'FEASIBLE']).toContain(staged.plan.main_schedule.solver.status)
  expect(staged.plan.main_schedule.metrics.device_conflicts).toBe(0)
  expect(staged.plan.main_schedule.metrics.dependency_violations).toBe(0)

  console.info('staged', JSON.stringify({
    recipe_ids: ids,
    target_ready_at: echoed,
    status: staged.plan.status,
    can_start_main: staged.plan.can_start_main,
    advance_task_ids: staged.plan.advance_task_ids,
    timing,
  }))
}, 180000)
