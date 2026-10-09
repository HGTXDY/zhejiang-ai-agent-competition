/** A planning hint derived only from the chosen target time and solver makespan.
 * It is not the actual execution clock, which starts when cooking begins.
 */
export function suggestedStartTime(targetTime: string, makespanSec: number): { time: string; daysBefore: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(targetTime)
  if (!match || !Number.isFinite(makespanSec) || makespanSec < 0) return null
  const hour = Number(match[1]); const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  const startMinutes = hour * 60 + minute - Math.ceil(makespanSec / 60)
  const wrappedMinutes = ((startMinutes % 1440) + 1440) % 1440
  return {
    time: `${String(Math.floor(wrappedMinutes / 60)).padStart(2, '0')}:${String(wrappedMinutes % 60).padStart(2, '0')}`,
    daysBefore: startMinutes < 0 ? Math.ceil(-startMinutes / 1440) : 0,
  }
}
