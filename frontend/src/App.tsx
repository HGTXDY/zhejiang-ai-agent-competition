import { useEffect, useMemo, useState } from 'react'
import ExecutionDashboard from './components/ExecutionDashboard'
import ModelSettingsDialog from './components/ModelSettingsDialog'
import PlanningModeChooser from './components/PlanningModeChooser'
import AgentPlanner from './components/AgentPlanner'
import { api, apiMode } from './api/client'
import { recipeCatalog as mockCatalog } from './mock/recipes'
import { createMockSchedule, validateProductRequest } from './mock/product'
import { productApi, productErrorMessage, assertSelection } from './api/product'
import type { ModelSettings, ModelSettingsUpdate, ParseResult, ParsedTask } from './api/product'
import type { DashboardSchedule } from './types/contracts'
import type { KitchenConfig, RecipeSummary } from './types/product'
import { apiModeLabel, formatDevice, formatDuration, formatMode } from './lib/presentation'
import './styles.css'

type ProductStep = 'recipes' | 'kitchen' | 'confirm' | 'result'
type PlanningMode = 'choose' | 'agent' | 'manual'
const productSteps: { key: ProductStep; number: string; label: string }[] = [
  { key: 'recipes', number: '01', label: '选择菜谱' }, { key: 'kitchen', number: '02', label: '厨房条件' },
  { key: 'confirm', number: '03', label: '确认步骤' }, { key: 'result', number: '04', label: '开始做饭' },
]
const defaultKitchen: KitchenConfig = { target_time: '12:30', operator_count: 1, stove_count: 1, steamer_count: 1, oven_count: 1, refrigerator_count: 1, dishwasher_count: 1, range_hood_count: 1, water_purifier_count: 1 }
const isHttp = import.meta.env.VITE_API_MODE === 'http'
const mockModelSettings: ModelSettings = { parser_provider: 'deterministic', configured: false, ready: false, base_url: null, model: 'gpt-4o-mini', api_key_masked: null, source: 'runtime', notes: [] }

export default function App() {
  const [recipeCatalog, setRecipeCatalog] = useState<RecipeSummary[]>([])
  const [parsed, setParsed] = useState<ParseResult[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [retry, setRetry] = useState(0)
  const [modelSettings, setModelSettings] = useState<ModelSettings>(mockModelSettings)
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false)
  const [modelBusy, setModelBusy] = useState(false)
  const [step, setStep] = useState<ProductStep>('recipes')
  const [planningMode, setPlanningMode] = useState<PlanningMode>('choose')
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [kitchen, setKitchen] = useState(defaultKitchen)
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [schedule, setSchedule] = useState<DashboardSchedule | null>(null)

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

  const selected = useMemo(() => selectedIds.map(id => recipeCatalog.find(recipe => recipe.recipe_id === id)).filter(Boolean) as RecipeSummary[], [selectedIds, recipeCatalog])
  const visibleRecipes = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized ? recipeCatalog.filter(recipe => recipe.name.toLowerCase().includes(normalized)) : recipeCatalog
  }, [query, recipeCatalog])

  function toggleRecipe(recipe: RecipeSummary) {
    if (loading) return
    setValidationErrors([]); setParsed([]); setConfirmed(false)
    setSelectedIds(current => current.includes(recipe.recipe_id) ? current.filter(id => id !== recipe.recipe_id) : current.length < 5 ? [...current, recipe.recipe_id] : current)
  }
  async function run(action: () => Promise<void>) {
    if (loading) return
    setLoading(true); setValidationErrors([]); setWarnings([])
    try { await action() } catch (error) { setValidationErrors([productErrorMessage(error)]) } finally { setLoading(false) }
  }
  async function continueToKitchen() { await run(async () => { assertSelection(selectedIds); setStep('kitchen') }) }
  async function confirmAgentPlan(ids: string[], agentKitchen: KitchenConfig) {
    await run(async () => {
      assertSelection(ids)
      let results: ParseResult[] = []
      if (isHttp) { await productApi.validateKitchen(agentKitchen); results = await productApi.parseSelection(ids, modelSettings.parser_provider) }
      else {
        const report = await validateProductRequest({ recipe_ids: ids, kitchen: agentKitchen })
        if (!report.valid) throw new Error(report.errors.join('；'))
        setWarnings(report.warnings)
      }
      setSelectedIds(ids); setKitchen(agentKitchen); setParsed(results); setConfirmed(false); setPlanningMode('manual'); setStep('confirm')
    })
  }
  async function continueToConfirm() {
    await run(async () => {
      assertSelection(selectedIds)
      let results: ParseResult[] = []
      if (isHttp) {
        await productApi.validateKitchen(kitchen)
        // The fixed/manual flow is deterministic by design. The configured
        // model belongs only to the conversational Agent path and must never
        // make the third-step calculation depend on an external LLM.
        results = await productApi.parseSelection(selectedIds, 'deterministic')
      }
      else {
        const report = await validateProductRequest({ recipe_ids: selectedIds, kitchen })
        if (!report.valid) throw new Error(report.errors.join('；'))
        setWarnings(report.warnings)
      }
      setParsed(results); setConfirmed(false); setStep('confirm')
    })
  }
  async function createSchedule() {
    await run(async () => {
      if (!confirmed) throw new Error('请先确认菜谱步骤')
      if (isHttp) {
        const result = await productApi.createSchedule(selectedIds, kitchen, parsed)
        api.setScheduleRequest({ ...result.request }); setSchedule({ ...result.schedule, target_time: kitchen.target_time, tasks: result.schedule.tasks.map(task => ({ ...task, dish_name: selected.find(recipe => recipe.recipe_id === task.dish_id)?.name })) })
      } else {
        const result = await createMockSchedule({ recipe_ids: selectedIds, kitchen })
        if (!result.validation.valid) throw new Error(result.validation.errors.join('；'))
        setSchedule({ ...result.schedule, target_time: kitchen.target_time, tasks: result.schedule.tasks.map(task => ({ ...task, dish_name: selected.find(recipe => recipe.recipe_id === task.dish_id)?.name })) })
      }
      setStep('result')
    })
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
    // The first step initially shows the planning-mode chooser. Clicking the
    // stepper must still enter the manual recipe catalog even though `step`
    // is already `recipes`; otherwise the catalog stays hidden behind the
    // chooser and users cannot see the official dishes.
    if (target === 'recipes') {
      setValidationErrors([]); setWarnings([]); setConfirmed(false); setPlanningMode('manual'); setStep('recipes'); return
    }
    if (target === step) return
    if (target === 'kitchen') { void continueToKitchen(); return }
    if (target === 'confirm') { void continueToConfirm(); return }
    if (schedule) setStep('result'); else setValidationErrors(['请先确认菜谱步骤并生成做饭计划'])
  }

  if (step === 'result' && schedule) return <ExecutionDashboard
    initialSchedule={schedule}
    recipes={recipeCatalog}
    onBackToPlanner={() => { setSchedule(null); setParsed([]); setConfirmed(false); setValidationErrors([]); setWarnings([]); setPlanningMode('choose'); setStep('recipes') }}
  />
  return <main className="product-shell">
    <header className="product-topbar">
      <div className="brand"><div className="brand-mark" aria-hidden="true">灶</div><div><strong>灶序</strong><span>智能做饭指挥台</span></div></div>
      <div className="topbar-actions">
        <div className="product-status"><span className="status-dot" />{apiModeLabel(apiMode)} · 可以开始规划</div>
        <button type="button" className="model-settings-trigger" aria-label="打开智能解析设置" onClick={() => setModelSettingsOpen(true)}>
          <span className={modelSettings.parser_provider === 'llm' ? (modelSettings.ready ? 'model-pulse active' : 'model-pulse warning') : 'model-pulse'} />
          <span className="model-trigger-copy"><small>菜谱理解</small><strong>{modelSettings.parser_provider === 'llm' ? (modelSettings.ready ? '智能模式' : '尚未连接') : '稳定模式'}</strong></span><b>设置</b>
        </button>
      </div>
    </header>
    <section className="product-content">
      <div className="product-heading"><div><p className="eyebrow">今天的菜单</p><h1>选好菜，<span>准时开饭。</span></h1><p className="subtitle">选 3～5 道菜，告诉我们厨房条件，系统会安排先后顺序和并行步骤。</p></div><div className="selection-count"><strong>{selected.length}</strong><span>/ 5 道已选</span></div></div>
      <nav className="stepper" aria-label="排程创建步骤">{productSteps.map(({ key, number, label }, index) => <button type="button" key={key} aria-current={step === key ? 'step' : undefined} className={`${step === key ? 'active' : ''} ${productSteps.findIndex(item => item.key === step) > index ? 'done' : ''}`} disabled={loading} onClick={() => navigateTo(key)}><b>{number}</b><span>{label}</span></button>)}</nav>
      <div className="product-messages">{validationErrors.length > 0 && <div className="product-alert error-banner">⚠ {validationErrors.map(error => <span key={error}>{error}</span>)}</div>}{warnings.length > 0 && <div className="product-alert warning-banner">△ {warnings.map(warning => <span key={warning}>{warning}</span>)}</div>}{catalogLoading && <p role="status">正在加载菜谱…</p>}{catalogError && <div className="error-banner">{catalogError}<button onClick={() => setRetry(value => value + 1)}>重新加载</button></div>}</div>
      {planningMode === 'choose' && <PlanningModeChooser onAgent={() => setPlanningMode('agent')} onManual={() => setPlanningMode('manual')} />}
      {planningMode === 'agent' && <AgentPlanner catalog={recipeCatalog} loading={loading} modelReady={isHttp && modelSettings.ready} offlineDemo={!isHttp} onOpenSettings={() => setModelSettingsOpen(true)} onBack={() => setPlanningMode('choose')} onConfirm={confirmAgentPlan} />}
      {planningMode === 'manual' && step === 'recipes' && <RecipeStep recipes={visibleRecipes} selected={selected} selectedIds={selectedIds} query={query} loading={loading || catalogLoading} onQuery={setQuery} onToggle={toggleRecipe} onNext={() => void continueToKitchen()} />}
      {planningMode === 'manual' && step === 'kitchen' && <KitchenStep kitchen={kitchen} selected={selected} loading={loading} onChange={setKitchen} onBack={() => setStep('recipes')} onNext={() => void continueToConfirm()} />}
      {planningMode === 'manual' && step === 'confirm' && <ConfirmStep kitchen={kitchen} selected={selected} parsed={parsed} confirmed={confirmed} loading={loading} setConfirmed={setConfirmed} onBack={() => setStep('kitchen')} onSubmit={() => void createSchedule()} />}
    </section>
    {modelSettingsOpen && <ModelSettingsDialog open settings={modelSettings} busy={modelBusy} onClose={() => setModelSettingsOpen(false)} onSave={updateModelSettings} onTest={testModelSettings} onReset={resetModelSettings} />}
  </main>
}

function RecipeStep({ recipes, selected, selectedIds, query, loading, onQuery, onToggle, onNext }: { recipes: RecipeSummary[]; selected: RecipeSummary[]; selectedIds: string[]; query: string; loading: boolean; onQuery: (value: string) => void; onToggle: (recipe: RecipeSummary) => void; onNext: () => void }) {
  const isFiltering = query.trim().length > 0
  return <section className="planner-grid"><div className="planner-main"><div className="section-toolbar"><div><p className="eyebrow">官方菜谱库</p><h2>选择今天要做的菜</h2><p>已接入 {recipes.length}{isFiltering ? ` 道匹配菜谱` : ' 道官方菜谱'}，搜索只用于快速检索，不影响菜谱库展示。</p></div><label className="search-box"><span aria-hidden="true">⌕</span><span className="sr-only">搜索菜谱</span><input value={query} onChange={event => onQuery(event.target.value)} placeholder="搜索菜名" /></label></div>{recipes.length ? <div className="recipe-grid">{recipes.map(recipe => <button type="button" key={recipe.recipe_id} aria-pressed={selectedIds.includes(recipe.recipe_id)} className={`recipe-card ${selectedIds.includes(recipe.recipe_id) ? 'selected' : ''}`} onClick={() => onToggle(recipe)}><span className="recipe-check" aria-hidden="true">{selectedIds.includes(recipe.recipe_id) ? '✓' : '+'}</span><div><strong>{recipe.name}</strong><small>{recipe.step_count} 个步骤 · {recipe.tags.join(' · ')}</small><p>{recipe.preview}</p></div></button>)}</div> : <div className="recipe-empty"><strong>{isFiltering ? '没有找到匹配的菜谱' : '官方菜谱暂时没有加载出来'}</strong><span>{isFiltering ? '换一个菜名试试。' : '请检查后端服务是否已启动，然后重新加载。'}</span>{isFiltering && <button type="button" className="text-button" onClick={() => onQuery('')}>清除搜索</button>}</div>}</div><aside className="selection-panel"><div className="selection-panel-heading"><div><p className="eyebrow">已选菜品</p><h2>本次菜单</h2></div><strong>{selected.length}<small>/ 5</small></strong></div>{selected.length ? <div className="selected-list">{selected.map((recipe, index) => <div className="selected-recipe" key={recipe.recipe_id}><span>{index + 1}</span><div><b>{recipe.name}</b><small>{recipe.step_count} 个步骤</small></div><button type="button" aria-label={`移除${recipe.name}`} onClick={() => onToggle(recipe)}>×</button></div>)}</div> : <div className="selection-empty"><span aria-hidden="true">＋</span><p>从左侧选择 3～5 道菜。</p></div>}<button type="button" className="primary wide" disabled={loading} onClick={onNext}>下一步：配置厨房 →</button><p className="selection-requirement">至少选择 3 道菜，最多 5 道</p></aside><div className="mobile-selection-dock"><div><strong>已选 {selected.length} 道</strong><span>至少 3 道，最多 5 道</span></div><button className="primary" disabled={loading} onClick={onNext}>配置厨房</button></div></section>
}

function KitchenStep({ kitchen, selected, loading, onChange, onBack, onNext }: { kitchen: KitchenConfig; selected: RecipeSummary[]; loading: boolean; onChange: (next: KitchenConfig) => void; onBack: () => void; onNext: () => void }) {
  const update = (key: keyof KitchenConfig, value: string) => onChange({ ...kitchen, [key]: key === 'target_time' ? value : Number(value) })
  const fields: [keyof KitchenConfig, string, number][] = [['operator_count', '做饭人数', 4], ['stove_count', '灶眼', 8], ['steamer_count', '蒸箱', 4], ['oven_count', '烤箱', 4], ['refrigerator_count', '冰箱', 4], ['dishwasher_count', '洗碗机', 4], ['range_hood_count', '烟机', 4], ['water_purifier_count', '净水机', 4]]
  return <section className="setup-grid"><div className="setup-main"><div className="compact-heading"><p className="eyebrow">厨房条件</p><h2>告诉我你的厨房现在有什么</h2><p className="setup-copy">填写开饭时间和可用设备。系统只会安排当前厨房能够完成的步骤。</p></div><div className="config-card"><label className="target-time">希望几点开饭<input disabled={loading} type="time" value={kitchen.target_time} onChange={event => update('target_time', event.target.value)} /></label>{fields.map(([key, label, max]) => <label key={key}>{label}<span className="number-input"><button type="button" disabled={loading || Number(kitchen[key] ?? 0) <= (key === 'operator_count' ? 1 : 0)} onClick={() => update(key, String(Number(kitchen[key] ?? 0) - 1))}>−</button><input aria-label={label} disabled={loading} type="number" min={key === 'operator_count' ? 1 : 0} max={max} value={kitchen[key] ?? 0} onChange={event => update(key, event.target.value)} /><button type="button" disabled={loading || Number(kitchen[key] ?? 0) >= max} onClick={() => update(key, String(Number(kitchen[key] ?? 0) + 1))}>＋</button></span></label>)}</div><div className="setup-actions"><button className="secondary" disabled={loading} onClick={onBack}>← 返回选菜</button><button className="primary" disabled={loading} onClick={onNext}>下一步：解析确认 →</button></div></div><aside className="selection-panel"><p className="eyebrow">已选菜单</p><h2>{selected.length} 道菜</h2><div className="selected-list">{selected.map(recipe => <div className="selected-recipe compact" key={recipe.recipe_id}><span>✓</span><div><b>{recipe.name}</b><small>{recipe.step_count} 个步骤</small></div></div>)}</div></aside></section>
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

function ConfirmStep({ kitchen, selected, onBack, onSubmit, loading, parsed, confirmed, setConfirmed }: { parsed: ParseResult[]; confirmed: boolean; setConfirmed: (value: boolean) => void; kitchen: KitchenConfig; selected: RecipeSummary[]; onBack: () => void; onSubmit: () => void; loading: boolean }) {
  return <section className="confirm-grid"><div className="confirm-main"><div className="compact-heading"><p className="eyebrow">菜谱步骤</p><h2>确认菜谱解析结果</h2><p className="setup-copy">请看看步骤、用时和设备是否符合你的实际做法。这里仅展示做饭时真正需要的信息。</p></div><div className="confirm-results">{selected.map(recipe => { const result = parsed.find(item => item.recipe_id === recipe.recipe_id); return <article className="parse-card" key={recipe.recipe_id}><div><strong>{recipe.name}</strong><span className="parse-status">{result ? '已理解' : '已检查'}</span></div>{result?.tasks?.length ? <ol className="friendly-task-list">{result.tasks.map(task => <TaskSummary key={task.task_id} task={task} />)}</ol> : <p>{recipe.preview}</p>}</article> })}</div></div><aside className="selection-panel summary-panel"><p className="eyebrow">开饭计划</p><h2>准备安排时间</h2><div className="summary-row"><span>开饭时间</span><b>{kitchen.target_time}</b></div><div className="summary-row"><span>做饭人数</span><b>{kitchen.operator_count} 人</b></div><div className="summary-row"><span>主要设备</span><b>{kitchen.stove_count} 个灶眼 · {kitchen.steamer_count} 台蒸箱 · {kitchen.oven_count} 台烤箱</b></div><div className="setup-actions summary-actions"><button className="secondary" disabled={loading} onClick={onBack}>← 返回配置</button><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />以上步骤符合实际做法</label><button className="primary wide" disabled={loading || !confirmed} onClick={onSubmit}>{loading ? '正在安排…' : '生成初始排程 →'}</button></div></aside><div className="mobile-confirm-dock"><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />步骤符合实际做法</label><button className="primary" disabled={loading || !confirmed} onClick={onSubmit}>{loading ? '正在安排…' : '生成计划'}</button></div></section>
}
