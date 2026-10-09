/** Shared API error model used by both the HTTP adapter and the mock fault
 * injection, so a demo can surface the same tiered messages as production.
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Map a thrown error to a user-facing, tiered message.
 *
 * The competition demo must distinguish no-feasible-schedule (409), solver
 * timeout (504) and network failure instead of folding every error into a
 * generic "事件上报失败".
 */
export function classifyError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return `无可行排程：${error.message}`
    if (error.status === 504) return '求解超时，请稍后重试'
    if (error.status === 422) return `请求校验失败：${error.message}`
    return `${error.message}（${error.status}）`
  }
  if (error instanceof TypeError) return '网络连接失败，请检查后端服务'
  // Client-side guards throw plain Errors with actionable messages (e.g.
  // "缺少初始排程请求，请重新生成排程"); surface those instead of collapsing
  // them into the generic fallback.
  if (error instanceof Error) return error.message
  return fallback
}
