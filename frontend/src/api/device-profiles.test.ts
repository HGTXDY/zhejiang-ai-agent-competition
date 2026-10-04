import { describe, expect, it } from 'vitest'
import parserSource from '../../../backend/app/parser/deterministic.py?raw'
import deviceSchema from '../../../contracts/v1/schemas/device.schema.json'
import profiles from './device-profiles.json'
import { buildDeviceConfig } from './product'

const modeTable = parserSource.split('_MODE_TABLE:')[1].split('_DEFAULT_MODE:')[0]
const specs = parserSource.split('device_specs:')[1].split('devices = []')[0]
const kitchen = { target_time: '12:30', operator_count: 1, stove_count: 1, steamer_count: 1, oven_count: 1 }

describe('Parser-aligned demo device profiles', () => {
  for (const type of Object.keys(profiles) as (keyof typeof profiles)[]) {
    it(`${type} covers every current Parser standard mode`, () => {
      const block = modeTable.match(new RegExp(`"${type}": \\[([\\s\\S]*?)\\]`))?.[1]
      expect(block, 'Parser mode table must be readable').toBeTruthy()
      const modes = [...block!.matchAll(/\(\s*"[^"]*"\s*,\s*"([^"]+)"\s*\)/g)].map(match => match[1])
      expect(modes.length).toBeGreaterThan(0)
      expect([...profiles[type].modes].sort()).toEqual([...new Set(modes)].sort())
      const device = buildDeviceConfig(kitchen).devices.find(item => item.device_type === type)!
      expect([...device.capabilities.modes].sort()).toEqual([...new Set(modes)].sort())
    })
    it(`${type} matches canonical Parser temperature bounds and capacity`, () => {
      const spec = specs.match(new RegExp(`\\{[^{}]*"device_type": "${type}"[^{}]*\\}`))?.[0]
      expect(spec).toBeTruthy()
      for (const field of ['capacity_units', 'temperature_min_c', 'temperature_max_c'] as const) {
        const value = spec!.match(new RegExp(`"${field}": (-?\\d+)`))?.[1]
        expect(value, `${field} must be readable`).toBeDefined()
        expect(profiles[type][field]).toBe(Number(value))
      }
      expect(deviceSchema.properties.devices.items.properties.device_type.enum).toContain(type)
    })
  }
  it('does not share mutable capability objects between requests or burners', () => {
    const first = buildDeviceConfig({ ...kitchen, stove_count: 2 })
    first.devices[0].capabilities.modes.length = 0
    expect(first.devices[1].capabilities.modes.length).toBeGreaterThan(0)
    expect(buildDeviceConfig(kitchen).devices[0].capabilities.modes.length).toBeGreaterThan(0)
  })
})
