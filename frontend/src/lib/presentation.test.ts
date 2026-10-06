import { describe, expect, it } from 'vitest'
import { apiModeLabel, formatDevice, formatDuration, formatMode, formatResource, formatResources } from './presentation'

describe('presentation helpers', () => {
  it('turns technical values into reader-friendly Chinese', () => {
    expect(formatDuration(90)).toBe('2 分钟')
    expect(formatDuration(3600)).toBe('1 小时')
    expect(formatDevice('steamer')).toBe('蒸箱')
    expect(formatMode('stir_fry')).toBe('炒制')
    expect(formatResource('operator_1')).toBe('操作台 1')
    expect(formatResources(['stove_1', 'oven_2'])).toBe('灶具 1、烤箱 2')
    expect(apiModeLabel('MOCK API')).toBe('演示模式')
  })
})
