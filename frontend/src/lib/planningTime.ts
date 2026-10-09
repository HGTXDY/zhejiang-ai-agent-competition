/**
 * Local-time helpers shared by the kitchen configuration and the P3 result page.
 *
 * Every function here works with the viewer's local calendar fields
 * (`getFullYear/getMonth/getDate/getHours/getMinutes`). We never derive a
 * calendar day from `toISOString()`, because that converts to UTC first and
 * would shift the date for any timezone east or west of Greenwich.
 *
 * `target_ready_at` stays a real ISO-8601 instant (it must carry an offset for
 * the backend contract); only *display* and *input* go through the local
 * helpers below.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_PATTERN = /^(\d{2}):(\d{2})$/

export const MS_PER_MINUTE = 60_000
export const MS_PER_DAY = 86_400_000

/** Build a local Date from explicit calendar fields. Never parses a UTC string. */
function fromLocalParts(year: number, month: number, day: number, hour: number, minute: number): Date {
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(hour, minute, 0, 0)
  return date
}

/** `YYYY-MM-DD` from a Date's local calendar fields. */
export function toDateInput(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** `HH:mm` from a Date's local clock fields. */
export function toTimeInput(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * Combine the user's chosen local date and time into a Date.
 * Returns null for malformed input or a non-existent local time
 * (for example 02:30 on a spring-forward DST day).
 */
export function parseLocalDateTime(dateValue: string, timeValue: string): Date | null {
  const dateMatch = DATE_PATTERN.exec(dateValue)
  const timeMatch = TIME_PATTERN.exec(timeValue)
  if (!dateMatch || !timeMatch) return null
  const year = Number(dateMatch[1])
  const month = Number(dateMatch[2])
  const day = Number(dateMatch[3])
  const hour = Number(timeMatch[1])
  const minute = Number(timeMatch[2])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (hour > 23 || minute > 59) return null
  const date = fromLocalParts(year, month, day, hour, minute)
  if (!Number.isFinite(date.getTime())) return null
  // Reject inputs the calendar normalized away (e.g. 2026-02-30 -> Mar 2).
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  if (date.getHours() !== hour || date.getMinutes() !== minute) return null
  return date
}

/** Reconstruct a stored ISO instant as a local Date, or null when unusable. */
export function parseInstant(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Split a stored ISO instant back into the local date/time input pair. */
export function instantToLocalInputs(value: string | null | undefined): { date: string; time: string } | null {
  const date = parseInstant(value)
  if (!date) return null
  return { date: toDateInput(date), time: toTimeInput(date) }
}

/** `10月11日 12:30` — the display form used wherever a full deadline is shown. */
export function formatLocalDateTime(value: string | Date | null | undefined): string | null {
  const date = value instanceof Date ? value : parseInstant(value)
  if (!date) return null
  return `${date.getMonth() + 1}月${date.getDate()}日 ${toTimeInput(date)}`
}

/** `10月11日` — date only. */
export function formatLocalDate(value: string | Date | null | undefined): string | null {
  const date = value instanceof Date ? value : parseInstant(value)
  if (!date) return null
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

/** Whole local calendar days from today to the given date. 0 = today, 1 = tomorrow. */
export function localDayDelta(date: Date, now: Date = new Date()): number {
  const startOfDay = (input: Date) => fromLocalParts(input.getFullYear(), input.getMonth() + 1, input.getDate(), 0, 0).getTime()
  return Math.round((startOfDay(date) - startOfDay(now)) / MS_PER_DAY)
}

/** Chinese label for a local calendar-day offset. */
export function describeDayDelta(delta: number): string {
  if (delta === 0) return '今天'
  if (delta === 1) return '明天'
  if (delta === 2) return '后天'
  if (delta < 0) return `已过去 ${Math.abs(delta)} 天`
  return `${delta} 天后`
}

/**
 * Guidance for the chosen dinner moment.
 *
 * An already-passed time is a hard error: the plan would be built against a
 * deadline that cannot be met, and the backend would happily schedule a
 * negative lead time. The caller surfaces this message and blocks submission
 * instead of quietly rolling the date forward.
 */
export function targetDateTimeError(dateValue: string, timeValue: string, now: Date = new Date()): string | null {
  const target = parseLocalDateTime(dateValue, timeValue)
  if (!target) return '请填写有效的开饭日期和时间（例如 2026-10-11 12:30）'
  if (target.getTime() <= now.getTime()) {
    return `开饭时间 ${formatLocalDateTime(target)} 已经过去，请选择今天稍后的时间或之后的日期`
  }
  return null
}

/**
 * The instant the solver optimises towards, or null when the selection is
 * unusable. This is the single source of truth for `target_ready_at`.
 */
export function targetReadyAt(dateValue: string, timeValue: string, now: Date = new Date()): string | null {
  if (targetDateTimeError(dateValue, timeValue, now)) return null
  const target = parseLocalDateTime(dateValue, timeValue)
  return target ? target.toISOString() : null
}

/**
 * Derive the "start cooking by" suggestion by subtracting the solver's real
 * makespan from the chosen deadline.
 *
 * Kept as an instant rather than an `HH:mm` string so a plan that crosses
 * midnight (or spans a 24-hour cold hold) keeps an honest date. `daysBefore`
 * is retained for callers that only show the clock time.
 */
export function suggestedStart(
  targetReadyAtValue: string | null | undefined,
  makespanSec: number,
): { at: Date; time: string; daysBefore: number } | null {
  const target = parseInstant(targetReadyAtValue)
  if (!target || !Number.isFinite(makespanSec) || makespanSec < 0) return null
  const start = new Date(target.getTime() - Math.ceil(makespanSec) * 1000)
  return {
    at: start,
    time: toTimeInput(start),
    daysBefore: localDayDelta(target) - localDayDelta(start),
  }
}

/** How far in the past an instant is, in milliseconds (0 when not in the past). */
export function overdueMs(value: string | Date | null | undefined, now: Date = new Date()): number {
  const date = value instanceof Date ? value : parseInstant(value)
  if (!date) return 0
  return Math.max(0, now.getTime() - date.getTime())
}
