import { describe, expect, it } from 'vitest'
import { ApiError, classifyError } from './errors'

describe('classifyError', () => {
  it('maps 409 to a distinct no-feasible-schedule message', () => {
    expect(classifyError(new ApiError('当前约束下无法生成可行排程', 409), 'fallback')).toBe('无可行排程：当前约束下无法生成可行排程')
  })

  it('maps 504 to a solver-timeout message', () => {
    expect(classifyError(new ApiError('求解器在时限内未收敛', 504), 'fallback')).toBe('求解超时，请稍后重试')
  })

  it('maps 422 to a validation message', () => {
    expect(classifyError(new ApiError('字段缺失', 422), 'fallback')).toBe('请求校验失败：字段缺失')
  })

  it('maps a TypeError to a network-failure message', () => {
    expect(classifyError(new TypeError('Failed to fetch'), 'fallback')).toBe('网络连接失败，请检查后端服务')
  })

  it('preserves status for other ApiError codes', () => {
    expect(classifyError(new ApiError('服务器内部错误', 500), 'fallback')).toBe('服务器内部错误（500）')
  })

  it('falls back for unrecognised errors', () => {
    expect(classifyError(new Error('boom'), 'fallback')).toBe('fallback')
  })
})

describe('ApiError', () => {
  it('is an Error with status and code preserved for the UI', () => {
    const error = new ApiError('无可行排程', 409, 'NO_FEASIBLE_SCHEDULE')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ApiError')
    expect(error.status).toBe(409)
    expect(error.code).toBe('NO_FEASIBLE_SCHEDULE')
  })
})
