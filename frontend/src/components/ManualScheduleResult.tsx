import { useState } from 'react'
import './ManualScheduleResult.css'
import type { ParsedTask, StagedPlanResponse } from '../api/product'
import type { DashboardSchedule } from '../types/contracts'
import type { RecipeSummary } from '../types/product'
import { formatDuration } from '../lib/presentation'
import { formatLocalDateTime, overdueMs, parseInstant, suggestedStart } from '../lib/planningTime'

interface Props {
  schedule: DashboardSchedule
  selected: RecipeSummary[]
  targetTime: string
  /** Full deadline instant chosen in the kitchen step; drives every time shown here. */
  targetReadyAt?: string | null
  loading: boolean
  staged?: StagedPlanResponse | null
  sourceTasks?: ParsedTask[]
  requiresStaged?: boolean
  onConfirmAdvance?: (taskIds: string[]) => void
  onRevise: () => void
  onStart: () => void
}

function advanceTaskStart(value: string | null, offsetSec: number): string | null {
  if (!value) return null
  const base = new Date(value).getTime()
  if (!Number.isFinite(base) || !Number.isFinite(offsetSec)) return null
  return localTime(new Date(base + offsetSec * 1000).toISOString(), true)
}

function localTime(value: string | null | undefined, withDate = false): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return withDate ? `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}` : hhmm
}

export default function ManualScheduleResult({ schedule, selected, targetTime, targetReadyAt, loading, staged, sourceTasks = [], requiresStaged = false, onConfirmAdvance, onRevise, onStart }: Props) {
  const [checkedIds, setCheckedIds] = useState<string[]>([])
  const { metrics, validation } = schedule
  const hasAdvance = Boolean(staged?.advance_task_ids.length)
  const timing = staged?.timing
  // One deadline for the whole page: the explicit instant chosen in the kitchen
  // step. `targetTime` (the raw HH:mm) remains only as a last-resort fallback so
  // an old persisted session still renders, and never silently shows a wrong day.
  const deadline = targetReadyAt ?? schedule.target_ready_at ?? null
  const deadlineLabel = formatLocalDateTime(deadline) ?? targetTime
  const deadlineDate = deadline ? formatLocalDateTime(deadline) : null
  const deadlineInstant = parseInstant(deadline)
  const deadlinePassed = deadlineInstant !== null && overdueMs(deadlineInstant) > 0
  const plannedStart = suggestedStart(deadline, metrics.makespan_sec)
  const mainStart = localTime(timing?.suggested_main_start_at) ?? (plannedStart ? localTime(plannedStart.at.toISOString(), true) : null)
  const ready = staged ? staged.can_start_main && staged.executable_main_request != null : !requiresStaged
  // A deadline that has already passed must not be presented as startable: the
  // remaining work cannot meet it, so the only honest action is to revise it.
  const safe = ready && !deadlinePassed && validation.valid && metrics.device_conflicts === 0 && metrics.dependency_violations === 0
  const advanceTasks = [...(staged?.advance_schedule?.tasks ?? [])].sort((a, b) => a.start_offset_sec - b.start_offset_sec)
  const sourceById = new Map(sourceTasks.map(task => [task.task_id, task]))
  const selectedById = new Map(selected.map(recipe => [recipe.recipe_id, recipe.name]))
  const pending = new Set(staged?.pending_advance_task_ids ?? [])
  const confirmed = staged ? staged.advance_task_ids.filter(id => !pending.has(id)) : []
  const allChecked = staged && checkedIds.length === staged.pending_advance_task_ids.length &&
    staged.pending_advance_task_ids.every(id => checkedIds.includes(id))
  const reviewRequired = (staged?.review_required.length ?? 0) > 0
  const advanceStartMs = timing?.suggested_advance_start_at ? new Date(timing.suggested_advance_start_at).getTime() : NaN
  const advanceStartsInPast = hasAdvance && Number.isFinite(advanceStartMs) && advanceStartMs < Date.now() - 60_000

  return <section className="setup-grid manual-result-grid" aria-label="排程结果确认">
    <div className="setup-main manual-result-main">
      <div className="compact-heading">
        <p className="eyebrow">排程成功</p>
        <h2>排程已生成</h2>
        <p className="setup-copy">确认本次菜单和预计时间，准备好后再开始做饭。</p>
      </div>
      <div className="result-time-grid">
        {mainStart && <div className="result-time-card">
          <span>{hasAdvance ? '正式烹饪建议开始' : '建议开始'}</span><strong>{mainStart}</strong>
          <small>{hasAdvance ? '已将提前准备独立安排，正式烹饪时间单独倒推' : `根据目标开饭时间和排程总用时倒推${plannedStart?.daysBefore ? ` · 提前 ${plannedStart.daysBefore} 天` : ''}`}</small>
        </div>}
        <div className={`result-time-card finish${deadlinePassed ? ' overdue' : ''}`}>
          <span>目标开饭</span><strong>{deadlineLabel}</strong>
          <small>{deadlinePassed ? '该时间已经过去，请返回修改开饭日期或时间' : deadlineDate && deadlineDate !== targetTime ? `你选择的开饭时刻：${deadlineDate}` : '按建议开始时间执行时的目标'}</small>
        </div>
      </div>
      {hasAdvance && timing ? <>
        <div className="result-metrics" aria-label="分阶段排程指标">
          <div><span>整体总历时（含提前准备）</span><strong>{formatDuration(timing.total_elapsed_sec)}</strong></div>
          <div><span>提前准备阶段</span><strong>{formatDuration(timing.advance_makespan_sec)}</strong></div>
          <div><span>正式烹饪阶段</span><strong>{formatDuration(timing.main_makespan_sec)}</strong></div>
        </div>
        <p className="result-metric-note">正式烹饪同出锅间隔：{formatDuration(metrics.finish_spread_sec)} · 全部任务：{advanceTasks.length + schedule.tasks.length} 步</p>
        <div className="result-advance" role="region" aria-label="提前准备计划">
          <div className="result-advance-heading">
            <h3>做饭前要完成的准备 <span>共 {advanceTasks.length} 项</span></h3>
            {timing.suggested_advance_start_at && <small>建议最早开始：{localTime(timing.suggested_advance_start_at, true)}</small>}
          </div>
          <p>请按各项建议时间完成准备。冷冻、腌制等等待时间已计入整体总历时；实际完成操作或等够时间后，再勾选“已完成”。</p>
          {advanceStartsInPast && <p className="result-advance-warning" role="status">建议的提前准备开始时间已经过去。如果尚未开始准备，可能无法按目标时间开饭；请返回修改开饭日期或时间并重新排程。系统不会假定你已经完成准备。</p>}
          {deadlinePassed && <p className="result-advance-warning" role="status">目标开饭时间 {deadlineLabel} 已经过去，这份计划无法按时执行，请返回修改开饭日期或时间。</p>}
          <ul>
            {advanceTasks.map((task, index) => {
              const original = sourceById.get(task.task_id)
              const dishName = selectedById.get(original?.dish_id ?? '') ?? selectedById.get(task.dish_id)
                ?? selected.find(recipe => task.task_id.startsWith(`${recipe.recipe_id}_`))?.name ?? '所选菜品'
              const action = original?.action?.trim() || '请按菜谱要求完成此项准备'
              const isWaiting = original?.resource_type === 'wait' || /冷冻|冷藏|腌制|浸泡|静置|发酵|风干/.test(action)
              const needsMinimum = /至少|以上|不低于/.test(action)
              const durationSec = original?.duration_sec ?? task.end_offset_sec - task.start_offset_sec
              const start = advanceTaskStart(timing.suggested_advance_start_at, task.start_offset_sec)
              const end = advanceTaskStart(timing.suggested_advance_start_at, task.end_offset_sec)
              const isPending = pending.has(task.task_id)
              return <li key={task.task_id}>
                <label>
                  <input type="checkbox" aria-label={`确认已完成：${dishName}第${index + 1}项准备`}
                    disabled={!isPending || loading || reviewRequired}
                    checked={!isPending || checkedIds.includes(task.task_id)}
                    onChange={event => setCheckedIds(ids => event.target.checked ? [...ids, task.task_id] : ids.filter(id => id !== task.task_id))} />
                  <span className="result-advance-task">
                    <span className="result-advance-step-label"><span>第 {index + 1} 项</span><span>{dishName}</span><em>{isWaiting ? '等待 / 提前处理' : '动手准备'}</em></span>
                    <b>{action}</b>
                    <small className="result-advance-duration">{needsMinimum ? '至少需要' : '预计需要'} {formatDuration(durationSec)}</small>
                    {start && end && <small className="result-advance-times">建议 {start} 开始 → {end} {needsMinimum ? '最早完成' : '预计完成'}</small>}
                    <span className="result-advance-done">{isPending ? '完成后勾选此项' : '已确认完成'}</span>
                  </span>
                </label>
              </li>
            })}
          </ul>
          {pending.size > 0 && !reviewRequired && <button type="button" className="secondary result-confirm-advance" disabled={loading || !allChecked} onClick={() => onConfirmAdvance?.([...confirmed, ...checkedIds])}>
            {loading ? '正在确认…' : `确认 ${pending.size} 项提前准备已实际完成`}
          </button>}
          {confirmed.length > 0 && pending.size === 0 && !reviewRequired && <div className="result-check-badge success">全部提前准备已确认，可以开始正式烹饪</div>}
        </div>
      </> : <div className="result-metrics" aria-label="排程指标">
        <div><span>预计总用时</span><strong>{formatDuration(staged?.timing.total_elapsed_sec ?? metrics.makespan_sec)}</strong></div>
        <div><span>同出锅间隔</span><strong>{formatDuration(metrics.finish_spread_sec)}</strong></div>
        <div><span>排程任务</span><strong>{schedule.tasks.length} 步</strong></div>
      </div>}
      {reviewRequired && <div className="result-advance-review" role="alert">
        <strong>以下提前准备步骤需要人工核查，请返回修改后重新生成排程：</strong>
        <ul>{staged!.review_required.map((item, index) => <li key={`${item.task_id}-${index}`}>{sourceById.get(item.task_id)?.action ?? '待核查的准备步骤'}：{item.reason}</li>)}</ul>
      </div>}
      {!hasAdvance && deadlinePassed && <p className="result-advance-review" role="alert">目标开饭时间 {deadlineLabel} 已经过去，这份计划无法按时执行，请返回修改开饭日期或时间后重新排程。</p>}
      {requiresStaged && !staged && <p className="result-advance-review">这是旧版本生成的排程，请返回修改并重新生成，以检查提前准备步骤。</p>}
      <div className="result-menu">
        <h3>本次菜单 <span>{selected.length} 道</span></h3>
        <ul>{selected.map((recipe, index) => <li key={recipe.recipe_id}>
          <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>{recipe.name}
        </li>)}</ul>
      </div>
      <div className="setup-actions result-actions">
        <button type="button" className="secondary" disabled={loading} onClick={onRevise}>← 返回修改</button>
        <button type="button" className="primary" disabled={loading || !safe} onClick={onStart}>开始做饭 →</button>
      </div>
    </div>
    <aside className="selection-panel summary-panel result-checks">
      <p className="eyebrow">本次计划</p><h2>排程检查</h2>
      <div className={`result-check-badge ${safe ? 'success' : 'warning'}`}>
        {safe ? '已通过约束校验' : deadlinePassed ? '目标开饭时间已过去' : reviewRequired ? '提前准备存在待核查步骤' : pending.size ? '待确认提前准备' : '尚不可执行，请检查排程'}
      </div>
      <div className="summary-row"><span>设备冲突</span><b>{metrics.device_conflicts} 项</b></div>
      <div className="summary-row"><span>依赖违规</span><b>{metrics.dependency_violations} 项</b></div>
      {validation.errors.length > 0 && <ul className="result-errors">{validation.errors.map((error, index) => <li key={`${error.code}-${index}`}>{error.message}</li>)}</ul>}
      <details className="result-schedule-id"><summary>查看排程编号</summary><code>{schedule.schedule_id}</code></details>
    </aside>
  </section>
}
