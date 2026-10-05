import { useEffect, useMemo, useState } from 'react'
import ExecutionDashboard from './components/ExecutionDashboard'
import { api, apiMode } from './api/client'
import { recipeCatalog as mockCatalog } from './mock/recipes'
import { createMockSchedule, validateProductRequest } from './mock/product'
import { productApi, productErrorMessage, assertSelection } from './api/product'
import type { ParseResult } from './api/product'
import type { DashboardSchedule } from './types/contracts'
import type { KitchenConfig, RecipeSummary } from './types/product'
import './styles.css'

type ProductStep = 'recipes' | 'kitchen' | 'confirm' | 'result'

const productSteps: { key: ProductStep; number: string; label: string }[] = [
  { key: 'recipes', number: '01', label: '选择菜谱' },
  { key: 'kitchen', number: '02', label: '配置厨房' },
  { key: 'confirm', number: '03', label: '解析确认' },
  { key: 'result', number: '04', label: '查看排程' },
]

const defaultKitchen: KitchenConfig = { target_time: '12:30', operator_count: 1, stove_count: 1, steamer_count: 1, oven_count: 1, refrigerator_count: 1, dishwasher_count: 1, range_hood_count: 1, water_purifier_count: 1 }
const isHttp = import.meta.env.VITE_API_MODE === 'http'

export default function App() {
  const [recipeCatalog, setRecipeCatalog] = useState<RecipeSummary[]>([])
  const [parsed, setParsed] = useState<ParseResult[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!isHttp) { setRecipeCatalog(mockCatalog); setCatalogLoading(false); return }
    let active = true
    setCatalogLoading(true); setCatalogError('')
    void productApi.listRecipes().then(recipes => { if (active) setRecipeCatalog(recipes) })
      .catch(error => { if (active) setCatalogError(productErrorMessage(error)) })
      .finally(() => { if (active) setCatalogLoading(false) })
    return () => { active = false }
  }, [retry])
  const [step, setStep] = useState<ProductStep>('recipes')
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [kitchen, setKitchen] = useState(defaultKitchen)
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [schedule, setSchedule] = useState<DashboardSchedule | null>(null)

  useEffect(() => {
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }, [step])

  const selected = useMemo(() => selectedIds.map(id => recipeCatalog.find(recipe => recipe.recipe_id === id)).filter(Boolean) as RecipeSummary[], [selectedIds, recipeCatalog])
  const visibleRecipes = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized ? recipeCatalog.filter(recipe => `${recipe.name}${recipe.preview}`.toLowerCase().includes(normalized)) : recipeCatalog
  }, [query, recipeCatalog])

  function toggleRecipe(recipe: RecipeSummary) {
    if (loading) return
    setValidationErrors([]); setParsed([]); setConfirmed(false)
    setSelectedIds(current => current.includes(recipe.recipe_id) ? current.filter(id => id !== recipe.recipe_id) : current.length < 5 ? [...current, recipe.recipe_id] : current)
  }

  async function run(action: () => Promise<void>) {
    if (loading) return
    setLoading(true); setValidationErrors([]); setWarnings([])
    try { await action() } catch (error) { setValidationErrors([productErrorMessage(error)]) }
    finally { setLoading(false) }
  }
  async function continueToKitchen() {
    await run(async () => { assertSelection(selectedIds); setStep('kitchen') })
  }
  async function continueToConfirm() {
    await run(async () => {
      assertSelection(selectedIds)
      let results: ParseResult[] = []
      if (isHttp) {
        await productApi.validateKitchen(kitchen)
        results = await productApi.parseSelection(selectedIds)
      } else {
        const report = await validateProductRequest({ recipe_ids: selectedIds, kitchen })
        if (!report.valid) throw new Error(report.errors.join('；'))
        setWarnings(report.warnings)
      }
      setParsed(results); setConfirmed(false); setStep('confirm')
    })
  }
  async function createSchedule() {
    await run(async () => {
      if (!confirmed) throw new Error('请先确认解析结果')
      if (isHttp) {
        const result = await productApi.createSchedule(selectedIds, kitchen, parsed)
        api.setScheduleRequest({ ...result.request })
        setSchedule(result.schedule)
      } else {
        const result = await createMockSchedule({ recipe_ids: selectedIds, kitchen })
        if (!result.validation.valid) throw new Error(result.validation.errors.join('；'))
        setSchedule(result.schedule)
      }
      setStep('result')
    })
  }

  function navigateTo(target: ProductStep) {
    if (loading || target === step) return
    if (target === 'recipes') {
      setValidationErrors([]); setWarnings([]); setConfirmed(false); setStep('recipes')
      return
    }
    if (target === 'kitchen') {
      void continueToKitchen()
      return
    }
    if (target === 'confirm') {
      void continueToConfirm()
      return
    }
    if (schedule) setStep('result')
    else setValidationErrors(['请先完成解析确认并生成初始排程'])
  }

  if (step === 'result' && schedule) return <ExecutionDashboard initialSchedule={schedule} />

  return <main className="product-shell">
    <header className="product-topbar"><div className="brand"><div className="brand-mark">灶</div><div><strong>灶序</strong><span>COOKFLOW AGENT</span></div></div><div className="product-status"><span className="status-dot" />厨房 A · 智能排程助手 · {apiMode}</div></header>
    <section className="product-content">
      <div className="product-heading"><div><p className="eyebrow">SMART COOKING PLANNER / V1</p><h1>从选菜开始，安排一场准时的晚餐。</h1><p className="subtitle">灶序会根据菜品、设备和目标开饭时间，生成可执行的烹饪排程。</p></div><div className="selection-count"><strong>{selected.length}</strong><span>/ 5 道菜已选</span></div></div>
      <nav className="stepper" aria-label="排程创建步骤">{productSteps.map(({ key, number, label }, index) => <button type="button" key={key} aria-current={step === key ? 'step' : undefined} className={`${step === key ? 'active' : ''} ${productSteps.findIndex(item => item.key === step) > index ? 'done' : ''}`} disabled={loading} onClick={() => navigateTo(key)}><b>{number}</b><span>{label}</span></button>)}</nav>
      {validationErrors.length > 0 && <div className="product-alert error-banner">⚠ {validationErrors.map(error => <span key={error}>{error}</span>)}</div>}
      {warnings.length > 0 && <div className="product-alert warning-banner">△ {warnings.map(warning => <span key={warning}>{warning}</span>)}</div>}
      {catalogLoading && <p role="status">正在加载官方菜谱…</p>}
      {catalogError && <div className="error-banner">{catalogError}<button onClick={() => setRetry(value => value + 1)}>重试加载</button></div>}
      {step === 'recipes' && <section className="planner-grid"><div className="planner-main"><div className="section-toolbar"><div><p className="eyebrow">RECIPE LIBRARY</p><h2>选择今天要做的菜</h2></div><label className="search-box">⌕<input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索菜名或步骤" /></label></div><div className="recipe-grid">{visibleRecipes.map(recipe => <button key={recipe.recipe_id} className={`recipe-card ${selectedIds.includes(recipe.recipe_id) ? 'selected' : ''}`} onClick={() => toggleRecipe(recipe)}><span className="recipe-check">{selectedIds.includes(recipe.recipe_id) ? '✓' : '+'}</span><div><strong>{recipe.name}</strong><small>{recipe.step_count} 个步骤 · {recipe.tags.join(' · ')}</small><p>{recipe.preview}</p></div></button>)}</div></div><aside className="selection-panel"><p className="eyebrow">SELECTED DISHES</p><h2>本次排程</h2>{selected.length ? selected.map((recipe, index) => <div className="selected-recipe" key={recipe.recipe_id}><span>{String(index + 1).padStart(2, '0')}</span><div><b>{recipe.name}</b><small>{recipe.step_count} 个步骤</small></div><button onClick={() => toggleRecipe(recipe)}>×</button></div>) : <p className="empty-state">请选择 3～5 道菜</p>}<button type="button" className="primary wide" disabled={loading || catalogLoading} aria-describedby="selection-requirement" onClick={() => void continueToKitchen()}>下一步：配置厨房 →</button><p id="selection-requirement" className={`selection-hint ${selected.length >= 3 ? 'ready' : ''}`}>{selected.length >= 3 ? '已满足要求，可以继续配置厨房' : `还需选择 ${3 - selected.length} 道菜（共需 3～5 道）`}</p></aside></section>}
      {step === 'kitchen' && <KitchenStep kitchen={kitchen} setKitchen={value => { setKitchen(value); setParsed([]); setConfirmed(false) }} loading={loading} onBack={() => setStep('recipes')} onNext={() => void continueToConfirm()} selected={selected} />}
      {step === 'confirm' && <ConfirmStep parsed={parsed} confirmed={confirmed} setConfirmed={setConfirmed} kitchen={kitchen} selected={selected} onBack={() => setStep('kitchen')} onSubmit={() => void createSchedule()} loading={loading} />}
    </section>
  </main>
}

function KitchenStep({ kitchen, setKitchen, onBack, onNext, selected, loading }: { kitchen: KitchenConfig; setKitchen: (value: KitchenConfig) => void; onBack: () => void; onNext: () => void; loading: boolean; selected: RecipeSummary[] }) {
  const update = (key: keyof KitchenConfig, value: string) => setKitchen({ ...kitchen, [key]: key === 'target_time' ? value : Number(value) })
  return <section className="setup-grid"><div className="setup-main"><p className="eyebrow">KITCHEN CONFIGURATION</p><h2>告诉我你的厨房现在有什么</h2><p className="setup-copy">排程 Agent 会把设备能力和操作员数量作为硬约束，不会安排无法执行的任务。当前使用 Parser 标准演示能力预设：覆盖契约七类设备的全部 Parser 标准模式、温区和容量（无温度要求的设备使用 null）。请确认实际设备支持此预设。目标时间取本地时区下一次到达该时刻。</p><div className="config-card"><label>目标开饭时间<input disabled={loading} type="time" value={kitchen.target_time} onChange={event => update('target_time', event.target.value)} /></label><label>操作员人数<input disabled={loading} type="number" min="1" max="4" value={kitchen.operator_count} onChange={event => update('operator_count', event.target.value)} /></label><label>灶眼数量<input disabled={loading} type="number" min="0" max="8" value={kitchen.stove_count} onChange={event => update('stove_count', event.target.value)} /></label><label>蒸箱数量<input disabled={loading} type="number" min="0" max="4" value={kitchen.steamer_count} onChange={event => update('steamer_count', event.target.value)} /></label><label>烤箱数量<input disabled={loading} type="number" min="0" max="4" value={kitchen.oven_count} onChange={event => update('oven_count', event.target.value)} /></label>{([['refrigerator_count', '冰箱数量'], ['dishwasher_count', '洗碗机数量'], ['range_hood_count', '烟机数量'], ['water_purifier_count', '净水机数量']] as const).map(([key, label]) => <label key={key}>{label}<input disabled={loading} type="number" min="0" max="4" value={kitchen[key] ?? 0} onChange={event => update(key, event.target.value)} /></label>)}</div><div className="setup-actions"><button className="secondary" disabled={loading} onClick={onBack}>← 返回选菜</button><button className="primary" disabled={loading} onClick={onNext}>下一步：解析确认 →</button></div></div><aside className="selection-panel"><p className="eyebrow">PLAN INPUT</p><h2>{selected.length} 道菜</h2>{selected.map(recipe => <div className="selected-recipe compact" key={recipe.recipe_id}><span>✓</span><div><b>{recipe.name}</b><small>{recipe.step_count} 个步骤</small></div></div>)}</aside></section>
}

function ConfirmStep({ kitchen, selected, onBack, onSubmit, loading, parsed, confirmed, setConfirmed }: { parsed: ParseResult[]; confirmed: boolean; setConfirmed: (value: boolean) => void; kitchen: KitchenConfig; selected: RecipeSummary[]; onBack: () => void; onSubmit: () => void; loading: boolean }) {
  return <section className="confirm-grid"><div className="confirm-main"><p className="eyebrow">PARSER REVIEW</p><h2>确认菜谱解析结果</h2><p className="setup-copy">{isHttp ? '以下为后端真实解析任务。请核对时长、设备要求与字段来源；缺失字段暂不支持补录，会阻止提交。' : 'Mock 离线演示：已检查选菜和厨房配置，使用现有本地演示数据生成排程，不调用后端解析器或求解器。'}</p>{selected.map(recipe => <article className="parse-card" key={recipe.recipe_id}><div><strong>{recipe.name}</strong><span className="parse-status">{parsed.find(result => result.recipe_id === recipe.recipe_id)?.provider ?? 'Mock'}</span></div>{!isHttp && <p>{recipe.preview}</p>}{parsed.find(result => result.recipe_id === recipe.recipe_id)?.tasks.map(task => <p key={task.task_id}>{task.action} · {task.duration_sec} 秒 · {task.device_requirement ? `${task.device_requirement.device_type} / ${task.device_requirement.mode ?? '未指定模式'} / ${task.device_requirement.temperature_c ?? '未指定'}℃` : task.resource_type}<small>{Object.entries(task.field_status ?? {}).map(([field, status]) => `${field}: ${status}`).join(' · ')}{task.confidence != null ? ` · 置信度 ${task.confidence}` : ''}</small></p>)}</article>)}</div><aside className="selection-panel summary-panel"><p className="eyebrow">SCHEDULE SUMMARY</p><h2>准备生成排程</h2><div className="summary-row"><span>目标开饭</span><b>{kitchen.target_time}</b></div><div className="summary-row"><span>操作员</span><b>{kitchen.operator_count} 人</b></div><div className="summary-row"><span>设备</span><b>{kitchen.stove_count} 灶 · {kitchen.steamer_count} 蒸箱 · {kitchen.oven_count} 烤箱 · {kitchen.refrigerator_count ?? 0} 冰箱 · {kitchen.dishwasher_count ?? 0} 洗碗机 · {kitchen.range_hood_count ?? 0} 烟机 · {kitchen.water_purifier_count ?? 0} 净水机</b></div><div className="setup-actions"><button className="secondary" disabled={loading} onClick={onBack}>← 返回配置</button><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已核对并确认解析结果</label><button className="primary wide" disabled={loading || !confirmed} onClick={onSubmit}>{loading ? '排程计算中…' : '生成初始排程 →'}</button></div></aside></section>
}
