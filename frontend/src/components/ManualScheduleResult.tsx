import type { DashboardSchedule } from '../types/contracts'
import type { RecipeSummary } from '../types/product'
import { formatDuration } from '../lib/presentation'
import { suggestedStartTime } from '../lib/planningTime'

interface Props {
  schedule: DashboardSchedule
  selected: RecipeSummary[]
  targetTime: string
  loading: boolean
  onRevise: () => void
  onStart: () => void
}

export default function ManualScheduleResult({ schedule, selected, targetTime, loading, onRevise, onStart }: Props) {
  const { metrics, validation } = schedule
  const plannedStart = suggestedStartTime(targetTime, metrics.makespan_sec)
  const safe = validation.valid && metrics.device_conflicts === 0 && metrics.dependency_violations === 0

  return <section className="setup-grid manual-result-grid" aria-label="排程结果确认">
    <div className="setup-main manual-result-main">
      <div className="compact-heading">
        <p className="eyebrow">排程成功</p>
        <h2>排程已生成</h2>
        <p className="setup-copy">确认本次菜单和预计时间，准备好后再开始做饭。</p>
      </div>
      <div className="result-time-grid">
        {plannedStart && <div className="result-time-card">
          <span>建议开始</span><strong>{plannedStart.time}</strong>
          <small>根据目标开饭时间和排程总用时倒推{plannedStart.daysBefore ? ` · 提前 ${plannedStart.daysBefore} 天` : ''}</small>
        </div>}
        <div className="result-time-card finish">
          <span>计划完成</span><strong>{targetTime}</strong>
          <small>按建议开始时间执行时的目标</small>
        </div>
      </div>
      <div className="result-metrics" aria-label="排程指标">
        <div><span>预计总用时</span><strong>{formatDuration(metrics.makespan_sec)}</strong></div>
        <div><span>同出锅间隔</span><strong>{formatDuration(metrics.finish_spread_sec)}</strong></div>
        <div><span>排程任务</span><strong>{schedule.tasks.length} 步</strong></div>
      </div>
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
        {safe ? '已通过约束校验' : '请检查排程约束'}
      </div>
      <div className="summary-row"><span>设备冲突</span><b>{metrics.device_conflicts} 项</b></div>
      <div className="summary-row"><span>依赖违规</span><b>{metrics.dependency_violations} 项</b></div>
      {validation.errors.length > 0 && <ul className="result-errors">{validation.errors.map((error, index) => <li key={`${error.code}-${index}`}>{error.message}</li>)}</ul>}
      <details className="result-schedule-id"><summary>查看排程编号</summary><code>{schedule.schedule_id}</code></details>
    </aside>
  </section>
}
