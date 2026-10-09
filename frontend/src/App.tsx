import { useEffect, useMemo, useState } from 'react'
import ExecutionDashboard from './components/ExecutionDashboard'
import ModelSettingsDialog from './components/ModelSettingsDialog'
import ManualScheduleResult from './components/ManualScheduleResult'
import PlanningModeChooser from './components/PlanningModeChooser'
import AgentPlanner from './components/AgentPlanner'
import { api } from './api/client'
import { recipeCatalog as mockCatalog } from './mock/recipes'
import { createMockSchedule, validateProductRequest } from './mock/product'
import { productApi, productErrorMessage, assertSelection, kitchenTargetReadyAt, toDashboard } from './api/product'
import type { InitialRequest, ModelSettings, ModelSettingsUpdate, ParseResult, ParsedTask, StagedPlanResponse } from './api/product'
import type { DashboardSchedule } from './types/contracts'
import type { KitchenConfig, RecipeSummary } from './types/product'
import { formatDevice, formatDuration, formatMode } from './lib/presentation'
import { clearAll, loadSession, saveSession } from './lib/persistence'
import { describeDayDelta, formatLocalDateTime, localDayDelta, MS_PER_DAY, parseLocalDateTime, targetDateTimeError, toDateInput } from './lib/planningTime'
import './styles.css'

type ProductStep = 'recipes' | 'kitchen' | 'confirm' | 'result'
type PlanningMode = 'choose' | 'agent' | 'manual'
type PlanSource = 'agent' | 'manual'
const productSteps: { key: ProductStep; number: string; label: string }[] = [
  { key: 'recipes', number: '01', label: '选择菜谱' }, { key: 'kitchen', number: '02', label: '厨房条件' },
  { key: 'confirm', number: '03', label: '确认步骤' }, { key: 'result', number: '04', label: '开始做饭' },
]
const agentSteps: { key: ProductStep; number: string; label: string }[] = [
  { key: 'recipes', number: '01', label: '收集需求' },
  { key: 'confirm', number: '02', label: '确认信息' },
  { key: 'result', number: '03', label: '开始做饭' },
]
const defaultKitchen: KitchenConfig = { target_date: toDateInput(new Date()), target_time: '12:30', operator_count: 1, stove_count: 1, steamer_count: 1, oven_count: 1, refrigerator_count: 1, dishwasher_count: 1, range_hood_count: 1, water_purifier_count: 1 }
const isHttp = import.meta.env.VITE_API_MODE === 'http'
const mockModelSettings: ModelSettings = { parser_provider: 'deterministic', configured: false, ready: false, base_url: null, model: 'gpt-4o-mini', api_key_masked: null, source: 'runtime', notes: [] }

export default function App() {
  const [saved] = useState(() => loadSession())
  const [recipeCatalog, setRecipeCatalog] = useState<RecipeSummary[]>([])
  const [parsed, setParsed] = useState<ParseResult[]>(saved?.parsed ?? [])
  const [confirmed, setConfirmed] = useState(saved?.confirmed ?? false)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [retry, setRetry] = useState(0)
  const [modelSettings, setModelSettings] = useState<ModelSettings>(mockModelSettings)
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false)
  const [modelBusy, setModelBusy] = useState(false)
  const [step, setStep] = useState<ProductStep>(saved?.step ?? 'recipes')
  const [planningMode, setPlanningMode] = useState<PlanningMode>(saved?.planningMode ?? 'choose')
  const [planSource, setPlanSource] = useState<PlanSource>(saved?.planSource ?? 'manual')
  const [manualFlow, setManualFlow] = useState(saved?.manualFlow ?? false)
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>(saved?.selectedIds ?? [])
  const [kitchen, setKitchen] = useState<KitchenConfig>(() => {
    const restored = saved?.kitchen
    if (!restored) return defaultKitchen
    // Sessions saved before the date picker only carry a clock time. Fill the
    // missing day with today rather than leaving the input blank, but never
    // overwrite a day the user actually chose.
    return restored.target_date ? restored : { ...restored, target_date: toDateInput(new Date()) }
  })
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [schedule, setSchedule] = useState<DashboardSchedule | null>(saved?.schedule ?? null)
  const [executionStarted, setExecutionStarted] = useState(saved?.executionStarted ?? false)
  const [stagedPlan, setStagedPlan] = useState<StagedPlanResponse | null>(saved?.stagedPlan ?? null)
  const [stagedRequest, setStagedRequest] = useState<InitialRequest | null>(saved?.stagedRequest ?? null)

  useEffect(() => {
    if (!isHttp) { setRecipeCatalog(mockCatalog); setCatalogLoading(false); return }
    let active = true
    setCatalogLoading(true); setCatalogError('')
    void productApi.listRecipes().then(recipes => { if (active) setRecipeCatalog(recipes) })
      .catch(error => { if (active) setCatalogError(productErrorMessage(error)) })
      .finally(() => { if (active) setCatalogLoading(false) })
    void productApi.getModelSettings().then(settings => { if (active) setModelSettings(settings) }).catch(() => undefined)
    return () => { active = false }
  }, [retry])

  useEffect(() => {
    saveSession({ planningMode, planSource, manualFlow, step, selectedIds, kitchen, parsed, confirmed, schedule, executionStarted, stagedPlan, stagedRequest })
  }, [planningMode, planSource, manualFlow, step, selectedIds, kitchen, parsed, confirmed, schedule, executionStarted, stagedPlan, stagedRequest])

  function clearStaged() { setStagedPlan(null); setStagedRequest(null) }

  // One derived deadline shared by the HTTP request builder, the Mock scheduler
  // and the P3 summary, so the plan and the page can never disagree.
  const targetIso = kitchenTargetReadyAt(kitchen)
  const targetIssue = targetDateTimeError(kitchen.target_date ?? '', kitchen.target_time)
  const selected = useMemo(() => selectedIds.map(id => recipeCatalog.find(recipe => recipe.recipe_id === id)).filter(Boolean) as RecipeSummary[], [selectedIds, recipeCatalog])
  const visibleSteps = planSource === 'agent' ? agentSteps : productSteps
  const visibleRecipes = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized ? recipeCatalog.filter(recipe => recipe.name.toLowerCase().includes(normalized)) : recipeCatalog
  }, [query, recipeCatalog])

  function toggleRecipe(recipe: RecipeSummary) {
    if (loading) return
    setValidationErrors([]); setParsed([]); setConfirmed(false); setSchedule(null); clearStaged(); setExecutionStarted(false)
    setSelectedIds(current => current.includes(recipe.recipe_id) ? current.filter(id => id !== recipe.recipe_id) : current.length < 5 ? [...current, recipe.recipe_id] : current)
  }
  async function run(action: () => Promise<void>) {
    if (loading) return
    setLoading(true); setValidationErrors([]); setWarnings([])
    try { await action() } catch (error) { setValidationErrors([productErrorMessage(error)]) } finally { setLoading(false) }
  }
  async function continueToKitchen() { await run(async () => { assertSelection(selectedIds); setSchedule(null); clearStaged(); setExecutionStarted(false); setConfirmed(false); setStep('kitchen') }) }
  async function prepareConfirmation(source: PlanSource, ids: string[], nextKitchen: KitchenConfig) {
    assertSelection(ids)
    let results: ParseResult[] = []
    if (isHttp) {
      await productApi.validateKitchen(nextKitchen)
      // Both entry modes share the same deterministic recipe parser. The LLM
      // only turns the Agent conversation into validated recipe and kitchen input.
      results = await productApi.parseSelection(ids, 'deterministic')
    } else {
      const report = await validateProductRequest({ recipe_ids: ids, kitchen: nextKitchen })
      if (!report.valid) throw new Error(report.errors.join('；'))
      setWarnings(report.warnings)
    }
    setPlanSource(source)
    setSelectedIds(ids)
    setKitchen(nextKitchen)
    setParsed(results)
    setSchedule(null); clearStaged()
    setExecutionStarted(false)
    setConfirmed(false)
    setStep('confirm')
  }
  async function confirmAgentPlan(ids: string[], agentKitchen: KitchenConfig) {
    await run(() => prepareConfirmation('agent', ids, agentKitchen))
  }
  async function continueToConfirm() {
    await run(() => prepareConfirmation('manual', selectedIds, kitchen))
  }
  async function createSchedule() {
    await run(async () => {
      if (!confirmed) throw new Error('请先确认菜谱步骤')
      if (isHttp && planSource === 'manual') {
        const result = await productApi.createStagedSchedule(selectedIds, kitchen, parsed)
        setStagedPlan(result.plan); setStagedRequest(result.request)
        if (result.plan.can_start_main && result.plan.executable_main_request) api.setScheduleRequest(result.plan.executable_main_request)
        setSchedule({ ...result.schedule, target_time: kitchen.target_time, target_ready_at: targetIso ?? undefined, tasks: result.schedule.tasks.map(task => ({ ...task, dish_name: selected.find(recipe => recipe.recipe_id === task.dish_id)?.name })) })
      } else if (isHttp) {
        // Keep the teammate's Agent path on the standard schedule endpoint.
        const result = await productApi.createSchedule(selectedIds, kitchen, parsed)
        api.setScheduleRequest({ ...result.request }); clearStaged()
        setSchedule({ ...result.schedule, target_time: kitchen.target_time, target_ready_at: targetIso ?? undefined, tasks: result.schedule.tasks.map(task => ({ ...task, dish_name: selected.find(recipe => recipe.recipe_id === task.dish_id)?.name })) })
      } else {
        const result = await createMockSchedule({ recipe_ids: selectedIds, kitchen })
        if (!result.validation.valid) throw new Error(result.validation.errors.join('；'))
        clearStaged()
        setSchedule({ ...result.schedule, target_time: kitchen.target_time, target_ready_at: targetIso ?? undefined, tasks: result.schedule.tasks.map(task => ({ ...task, dish_name: selected.find(recipe => recipe.recipe_id === task.dish_id)?.name })) })
      }
      setExecutionStarted(false); setStep('result')
    })
  }
  async function confirmAdvance(confirmedTaskIds: string[]) {
    await run(async () => {
      if (!isHttp || !stagedRequest || !stagedPlan) throw new Error('提前准备信息已失效，请重新生成排程')
      if (confirmedTaskIds.length !== stagedPlan.advance_task_ids.length ||
          new Set(confirmedTaskIds).size !== confirmedTaskIds.length ||
          confirmedTaskIds.some(id => !stagedPlan.advance_task_ids.includes(id))) {
        throw new Error('请先确认全部提前准备步骤')
      }
      const plan = await productApi.confirmStagedSchedule(stagedRequest, confirmedTaskIds)
      if (!plan.can_start_main || !plan.executable_main_request) throw new Error('仍有未完成或需要核查的提前准备步骤')
      api.setScheduleRequest(plan.executable_main_request)
      const schedule = toDashboard(plan.main_schedule, stagedRequest.tasks)
      setStagedPlan(plan)
      setSchedule({ ...schedule, target_time: kitchen.target_time, target_ready_at: targetIso ?? undefined, tasks: schedule.tasks.map(task => ({ ...task, dish_name: selected.find(recipe => recipe.recipe_id === task.dish_id)?.name })) })
    })
  }
  function startManualExecution() {
    if (isHttp) {
      if (!stagedPlan?.can_start_main || !stagedPlan.executable_main_request) return
      // Rehydrate replan context after a reload; preview plans are never executable.
      api.setScheduleRequest(stagedPlan.executable_main_request)
    }
    setExecutionStarted(true)
  }
  function updateKitchen(next: KitchenConfig) {
    setKitchen(next); setSchedule(null); clearStaged(); setExecutionStarted(false); setConfirmed(false)
  }
  function reviseGeneratedPlan() {
    setSchedule(null); clearStaged(); setExecutionStarted(false); setConfirmed(false); setStep(planSource === 'agent' ? 'recipes' : 'kitchen')
  }
  function resetPlanning() {
    if (!window.confirm('确定要重置所有计划数据吗？已选的菜谱、厨房条件、生成的排程和聊天记录都会被清空。')) return
    clearAll()
    setStep('recipes'); setPlanningMode('choose'); setPlanSource('manual'); setManualFlow(false); setQuery('')
    setSelectedIds([]); setKitchen(defaultKitchen); setParsed([]); setConfirmed(false); setSchedule(null); clearStaged(); setExecutionStarted(false)
    setValidationErrors([]); setWarnings([])
  }
  async function updateModelSettings(payload: ModelSettingsUpdate) {
    setModelBusy(true)
    try { setModelSettings((isHttp ? await productApi.updateModelSettings(payload) : { ...modelSettings, ...payload, configured: false, ready: false }) as ModelSettings); setParsed([]); setConfirmed(false) }
    finally { setModelBusy(false) }
  }
  async function testModelSettings(payload: ModelSettingsUpdate) {
    if (!isHttp) return '演示模式不连接外部智能服务'
    setModelBusy(true); try { return (await productApi.testModelSettings(payload)).message } finally { setModelBusy(false) }
  }
  async function resetModelSettings() {
    setModelBusy(true); try { setModelSettings(isHttp ? await productApi.resetModelSettings() : mockModelSettings); setParsed([]); setConfirmed(false) } finally { setModelBusy(false) }
  }
  function navigateTo(target: ProductStep) {
    if (loading) return
    if (planSource === 'agent') {
      if (target === 'recipes' || target === 'kitchen') {
        setValidationErrors([]); setWarnings([]); setConfirmed(false); setSchedule(null); clearStaged(); setExecutionStarted(false); setPlanningMode('agent'); setStep('recipes')
      } else if (target === 'confirm') {
        setValidationErrors([]); setSchedule(null); clearStaged(); setExecutionStarted(false); setConfirmed(false); setStep('confirm')
      } else if (schedule) setStep('result')
      else setValidationErrors(['请先确认菜谱步骤并生成做饭计划'])
      return
    }
    if (step === 'result' && target !== 'result') {
      setSchedule(null); clearStaged(); setExecutionStarted(false); setConfirmed(false)
      if (target === 'confirm') setStep('kitchen')
    }
    // The manual stepper must re-open the recipe catalog, even if this is
    // already the active step.
    if (target === 'recipes') {
      setValidationErrors([]); setWarnings([]); setConfirmed(false); setSchedule(null); clearStaged(); setExecutionStarted(false); setManualFlow(true); setPlanSource('manual'); setPlanningMode('manual'); setStep('recipes'); return
    }
    if (target === step) return
    if (target === 'kitchen') { void continueToKitchen(); return }
    if (target === 'confirm') { void continueToConfirm(); return }
    if (schedule) setStep('result'); else setValidationErrors(['请先确认菜谱步骤并生成做饭计划'])
  }

  if (step === 'result' && schedule && executionStarted) return <ExecutionDashboard
    initialSchedule={schedule}
    recipes={recipeCatalog}
    onBackToPlanner={() => setExecutionStarted(false)}
  />
  return <main className={`product-shell product-shell-${planningMode}`}>
    <header className="product-topbar">
      <div className="brand"><div className="brand-mark" aria-hidden="true">灶</div><div><strong>灶序・CookFlow</strong><span>智能做饭指挥台</span></div></div>
      <div className="topbar-actions">
        <div className="product-status"><span className="status-dot" />服务已连接</div>
        <div className="model-mode-status"><span className={modelSettings.parser_provider === 'llm' ? (modelSettings.ready ? 'model-pulse active' : 'model-pulse warning') : 'model-pulse'} />{modelSettings.parser_provider === 'llm' && modelSettings.ready ? '智能模式' : '稳定模式'}</div>
        <button type="button" className="reset-trigger" onClick={resetPlanning}>重置</button>
        <button type="button" className="model-settings-trigger" aria-label="打开智能解析设置" onClick={() => setModelSettingsOpen(true)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></svg>
          <span>设置</span>
        </button>
      </div>
    </header>
    <section className={`product-content product-content-${planningMode}`}>
      {((planningMode === 'manual' && manualFlow) || planningMode === 'agent') && <div className="manual-flow-header">
        <nav className="stepper" aria-label="排程创建步骤">{visibleSteps.map(({ key, number, label }, index) => <button type="button" key={key} aria-current={step === key ? 'step' : undefined} className={`${step === key ? 'active' : ''} ${visibleSteps.findIndex(item => item.key === step) > index ? 'done' : ''}`} disabled={loading} onClick={() => navigateTo(key)}><b>{number}</b><span>{label}</span></button>)}</nav>
        {planningMode === 'manual' && <div className="selection-count" aria-label={`已选择 ${selected.length} 道菜，最多 5 道`}><strong>{selected.length}</strong><span>/ 5 道已选</span></div>}
      </div>}
      <div className="product-messages">{validationErrors.length > 0 && <div className="product-alert error-banner">⚠ {validationErrors.map(error => <span key={error}>{error}</span>)}</div>}{warnings.length > 0 && <div className="product-alert warning-banner">△ {warnings.map(warning => <span key={warning}>{warning}</span>)}</div>}{catalogLoading && <p role="status">正在加载菜谱…</p>}{catalogError && <div className="error-banner">{catalogError}<button onClick={() => setRetry(value => value + 1)}>重新加载</button></div>}</div>
      {planningMode === 'choose' && <div className="choose-intro"><div className="choose-intro-copy"><span className="choose-intro-label">COOKFLOW / PLANNING DESK</span><p>两种方式，同一份清晰、可执行的做饭计划。</p></div></div>}
      {planningMode === 'choose' && <PlanningModeChooser onAgent={() => { setManualFlow(false); setPlanSource('agent'); setStep('recipes'); setPlanningMode('agent') }} onManual={() => { setManualFlow(true); setPlanSource('manual'); setStep('recipes'); setPlanningMode('manual') }} />}
      {planningMode === 'agent' && step !== 'result' && <AgentPlanner step={step === 'confirm' ? 'confirm' : 'recipes'} catalog={recipeCatalog} loading={loading} modelReady={isHttp && modelSettings.ready} offlineDemo={!isHttp} onOpenSettings={() => setModelSettingsOpen(true)} onBack={() => setPlanningMode('choose')} onConfirm={confirmAgentPlan} />}
      {planningMode === 'manual' && step === 'recipes' && <RecipeStep recipes={visibleRecipes} selected={selected} selectedIds={selectedIds} query={query} loading={loading || catalogLoading} onQuery={setQuery} onToggle={toggleRecipe} onExit={() => setPlanningMode('choose')} onNext={() => void continueToKitchen()} />}
      {planningMode === 'manual' && step === 'kitchen' && <KitchenStep kitchen={kitchen} selected={selected} loading={loading} targetIssue={targetIssue} onChange={updateKitchen} onBack={() => setStep('recipes')} onNext={() => void continueToConfirm()} />}
      {planningMode !== 'choose' && step === 'confirm' && <ConfirmStep source={planSource} kitchen={kitchen} targetReadyAt={targetIso} selected={selected} parsed={parsed} confirmed={confirmed} loading={loading} setConfirmed={setConfirmed} onBack={() => setStep(planSource === 'agent' ? 'recipes' : 'kitchen')} onSubmit={() => void createSchedule()} />}
      {planningMode === 'manual' && manualFlow && step === 'result' && schedule && !executionStarted && <ManualScheduleResult schedule={schedule} selected={selected} targetTime={kitchen.target_time} targetReadyAt={targetIso} loading={loading} staged={stagedPlan} sourceTasks={stagedRequest?.tasks ?? []} requiresStaged={isHttp} onConfirmAdvance={ids => void confirmAdvance(ids)} onRevise={reviseGeneratedPlan} onStart={startManualExecution} />}
      {planningMode === 'agent' && step === 'result' && schedule && !executionStarted && <section className="setup-grid"><div className="setup-main"><div className="compact-heading"><p className="eyebrow">排程成功</p><h2>排程已生成</h2><p className="setup-copy">做饭计划已经准备好。开始后将直接使用刚刚生成的这份排程。</p></div><div className="setup-actions"><button className="secondary" disabled={loading} onClick={reviseGeneratedPlan}>← 返回修改</button><button className="primary" disabled={loading} onClick={() => setExecutionStarted(true)}>开始做饭 →</button></div></div><aside className="selection-panel summary-panel"><p className="eyebrow">本次计划</p><h2>{selected.length} 道菜</h2><div className="summary-row"><span>目标开饭时间</span><b>{formatLocalDateTime(targetIso) ?? kitchen.target_time}</b></div><div className="summary-row"><span>排程编号</span><b>{schedule.schedule_id}</b></div></aside></section>}
    </section>
    {modelSettingsOpen && <ModelSettingsDialog open settings={modelSettings} busy={modelBusy} onClose={() => setModelSettingsOpen(false)} onSave={updateModelSettings} onTest={testModelSettings} onReset={resetModelSettings} />}
  </main>
}

function RecipeStep({ recipes, selected, selectedIds, query, loading, onQuery, onToggle, onExit, onNext }: { recipes: RecipeSummary[]; selected: RecipeSummary[]; selectedIds: string[]; query: string; loading: boolean; onQuery: (value: string) => void; onToggle: (recipe: RecipeSummary) => void; onExit: () => void; onNext: () => void }) {
  const isFiltering = query.trim().length > 0
  return <section className="planner-grid"><div className="planner-main"><button type="button" className="text-back" onClick={onExit}>← 返回主页</button><div className="section-toolbar"><div><p className="eyebrow">官方菜谱库</p><h2>选择今天要做的菜</h2><p>已接入 {recipes.length}{isFiltering ? ` 道匹配菜谱` : ' 道官方菜谱'}，搜索只用于快速检索，不影响菜谱库展示。</p></div><label className="search-box"><span aria-hidden="true">⌕</span><span className="sr-only">搜索菜谱</span><input value={query} onChange={event => onQuery(event.target.value)} placeholder="搜索菜名" /></label></div>{recipes.length ? <div className="recipe-grid">{recipes.map(recipe => <button type="button" key={recipe.recipe_id} aria-pressed={selectedIds.includes(recipe.recipe_id)} className={`recipe-card ${selectedIds.includes(recipe.recipe_id) ? 'selected' : ''}`} onClick={() => onToggle(recipe)}><span className="recipe-check" aria-hidden="true">{selectedIds.includes(recipe.recipe_id) ? '✓' : '+'}</span><div><strong>{recipe.name}</strong><small>{recipe.step_count} 个步骤 · {recipe.tags.join(' · ')}</small><p>{recipe.preview}</p></div></button>)}</div> : <div className="recipe-empty"><strong>{isFiltering ? '没有找到匹配的菜谱' : '官方菜谱暂时没有加载出来'}</strong><span>{isFiltering ? '换一个菜名或做法试试。' : '请检查后端服务是否已启动，然后重新加载。'}</span>{isFiltering && <button type="button" className="text-button" onClick={() => onQuery('')}>清除搜索</button>}</div>}</div><aside className="selection-panel"><div className="selection-panel-heading"><div><p className="eyebrow">已选菜品</p><h2>本次菜单</h2></div><strong>{selected.length}<small>/ 5</small></strong></div>{selected.length ? <div className="selected-list">{selected.map((recipe, index) => <div className="selected-recipe" key={recipe.recipe_id}><span>{index + 1}</span><div><b>{recipe.name}</b><small>{recipe.step_count} 个步骤</small></div><button type="button" aria-label={`移除${recipe.name}`} onClick={() => onToggle(recipe)}>×</button></div>)}</div> : <div className="selection-empty"><span aria-hidden="true">＋</span><p>从左侧选择 3～5 道菜。</p></div>}<button type="button" className="primary wide" disabled={loading || selected.length < 3} onClick={onNext}>下一步：配置厨房 →</button><p className="selection-requirement">至少选择 3 道菜，最多 5 道</p></aside><div className="mobile-selection-dock"><div><strong>已选 {selected.length} 道</strong><span>至少 3 道，最多 5 道</span></div><button className="primary" disabled={loading || selected.length < 3} onClick={onNext}>配置厨房</button></div></section>
}

function KitchenStep({ kitchen, selected, loading, targetIssue, onChange, onBack, onNext }: { kitchen: KitchenConfig; selected: RecipeSummary[]; loading: boolean; targetIssue: string | null; onChange: (next: KitchenConfig) => void; onBack: () => void; onNext: () => void }) {
  const update = (key: keyof KitchenConfig, value: string) => onChange({ ...kitchen, [key]: key === 'target_time' || key === 'target_date' ? value : Number(value) })
  const fields: [keyof KitchenConfig, string, number][] = [['operator_count', '做饭人数', 4], ['stove_count', '灶眼', 8], ['steamer_count', '蒸箱', 4], ['oven_count', '烤箱', 4], ['refrigerator_count', '冰箱', 4], ['dishwasher_count', '洗碗机', 4], ['range_hood_count', '烟机', 4], ['water_purifier_count', '净水机', 4]]
  // The chosen day drives the deadline, so show its distance from today in plain
  // words and let the user jump to today/tomorrow without opening the picker.
  const today = toDateInput(new Date())
  const tomorrow = toDateInput(new Date(Date.now() + MS_PER_DAY))
  const chosenDay = parseLocalDateTime(kitchen.target_date ?? today, kitchen.target_time)
  const dayNote = chosenDay ? describeDayDelta(localDayDelta(chosenDay)) : null
  const setDay = (value: string) => update('target_date', value)
  return <section className="setup-grid"><div className="setup-main"><div className="compact-heading"><p className="eyebrow">厨房条件</p><h2>告诉我你的厨房现在有什么</h2><p className="setup-copy">填写开饭的日期、时间和可用设备。系统只会安排当前厨房能够完成的步骤。</p></div><div className="config-card"><div className="target-datetime" role="group" aria-label="希望哪天几点开饭"><div className="target-datetime-field"><div className="target-date"><label htmlFor="target-date-input">希望哪天开饭</label><span className="date-with-quick"><input id="target-date-input" aria-label="希望哪天开饭" disabled={loading} type="date" min={today} value={kitchen.target_date ?? today} onChange={event => setDay(event.target.value)} /><span className="target-day-quick"><button type="button" className={kitchen.target_date === today ? 'active' : ''} disabled={loading} onClick={() => setDay(today)}>今天</button><button type="button" className={kitchen.target_date === tomorrow ? 'active' : ''} disabled={loading} onClick={() => setDay(tomorrow)}>明天</button>{dayNote && <small className="target-day-note">{dayNote}</small>}</span></span></div><label className="target-time">希望几点开饭<input aria-label="希望几点开饭" disabled={loading} type="time" value={kitchen.target_time} onChange={event => update('target_time', event.target.value)} /></label></div></div>{targetIssue && <p className="config-error" role="alert">{targetIssue}</p>}{fields.map(([key, label, max]) => <label key={key}>{label}<span className="number-input"><button type="button" disabled={loading || Number(kitchen[key] ?? 0) <= (key === 'operator_count' ? 1 : 0)} onClick={() => update(key, String(Number(kitchen[key] ?? 0) - 1))}>−</button><input aria-label={label} disabled={loading} type="number" min={key === 'operator_count' ? 1 : 0} max={max} value={kitchen[key] ?? 0} onChange={event => update(key, event.target.value)} /><button type="button" disabled={loading || Number(kitchen[key] ?? 0) >= max} onClick={() => update(key, String(Number(kitchen[key] ?? 0) + 1))}>＋</button></span></label>)}</div><div className="setup-actions"><button className="secondary" disabled={loading} onClick={onBack}>← 返回选菜</button><button className="primary" disabled={loading || Boolean(targetIssue)} onClick={onNext}>下一步：解析确认 →</button></div></div><aside className="selection-panel"><p className="eyebrow">已选菜单</p><h2>{selected.length} 道菜</h2><div className="selected-list">{selected.map(recipe => <div className="selected-recipe compact" key={recipe.recipe_id}><span>✓</span><div><b>{recipe.name}</b><small>{recipe.step_count} 个步骤</small></div></div>)}</div></aside></section>
}

function TaskSummary({ task }: { task: ParsedTask }) {
  const details = [formatDuration(task.duration_sec)]
  if (task.device_requirement) {
    details.push(formatDevice(task.device_requirement.device_type))
    const mode = formatMode(task.device_requirement.mode); if (mode) details.push(mode)
    if (task.device_requirement.temperature_c != null) details.push(`${task.device_requirement.temperature_c}℃`)
  } else if (task.manual_required || task.resource_type === 'manual') details.push('需要手动操作')
  else if (task.resource_type === 'wait') details.push('等待即可')
  return <li><span className="step-dot" aria-hidden="true" /><div><b>{task.action}</b><small>{details.join(' · ')}</small></div></li>
}

function ConfirmStep({ source, kitchen, targetReadyAt, selected, onBack, onSubmit, loading, parsed, confirmed, setConfirmed }: { source: PlanSource; parsed: ParseResult[]; confirmed: boolean; setConfirmed: (value: boolean) => void; kitchen: KitchenConfig; targetReadyAt: string | null; selected: RecipeSummary[]; onBack: () => void; onSubmit: () => void; loading: boolean }) {
  return <section className="confirm-grid"><div className="confirm-main"><div className="compact-heading"><p className="eyebrow">菜谱步骤{source === 'agent' ? ' · Agent智能规划' : ''}</p><h2>确认菜谱解析结果</h2><p className="setup-copy">请看看步骤、用时和设备是否符合你的实际做法。这里仅展示做饭时真正需要的信息。</p></div><div className="confirm-results">{selected.map(recipe => { const result = parsed.find(item => item.recipe_id === recipe.recipe_id); return <article className="parse-card" key={recipe.recipe_id}><div><strong>{recipe.name}</strong><span className="parse-status">{result ? '已理解' : '已检查'}</span></div>{result?.tasks?.length ? <ol className="friendly-task-list">{result.tasks.map(task => <TaskSummary key={task.task_id} task={task} />)}</ol> : <p>{recipe.preview}</p>}</article> })}</div></div><aside className="selection-panel summary-panel"><p className="eyebrow">开饭计划</p><h2>准备安排时间</h2><div className="summary-row"><span>开饭时间</span><b>{formatLocalDateTime(targetReadyAt) ?? kitchen.target_time}</b></div><div className="summary-row"><span>做饭人数</span><b>{kitchen.operator_count} 人</b></div><div className="summary-row"><span>厨房设备</span><b>{kitchen.stove_count} 个灶眼 · {kitchen.steamer_count} 台蒸箱 · {kitchen.oven_count} 台烤箱 · {kitchen.refrigerator_count ?? 0} 台冰箱 · {kitchen.dishwasher_count ?? 0} 台洗碗机 · {kitchen.range_hood_count ?? 0} 台烟机 · {kitchen.water_purifier_count ?? 0} 台净水机</b></div><div className="setup-actions summary-actions"><button className="secondary" disabled={loading} onClick={onBack}>{source === 'agent' ? '← 返回修改需求' : '← 返回配置'}</button><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />以上步骤符合实际做法</label><button className="primary wide" disabled={loading || !confirmed} onClick={onSubmit}>{loading ? '正在安排…' : '生成初始排程 →'}</button></div></aside><div className="mobile-confirm-dock"><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />步骤符合实际做法</label><button className="primary" disabled={loading || !confirmed} onClick={onSubmit}>{loading ? '正在安排…' : '生成计划'}</button></div></section>
}
