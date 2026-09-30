import { useMemo, useState } from 'react'
import ExecutionDashboard from './components/ExecutionDashboard'
import { recipeCatalog } from './mock/recipes'
import { createMockSchedule, validateProductRequest } from './mock/product'
import type { DashboardSchedule } from './types/contracts'
import type { KitchenConfig, RecipeSummary } from './types/product'
import './styles.css'

type ProductStep = 'recipes' | 'kitchen' | 'confirm' | 'result'

const defaultKitchen: KitchenConfig = { target_time: '12:30', operator_count: 1, stove_count: 1, steamer_count: 1, oven_count: 1 }

export default function App() {
  const [step, setStep] = useState<ProductStep>('recipes')
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>(recipeCatalog.slice(0, 3).map(recipe => recipe.recipe_id))
  const [kitchen, setKitchen] = useState(defaultKitchen)
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [schedule, setSchedule] = useState<DashboardSchedule | null>(null)

  const selected = useMemo(() => selectedIds.map(id => recipeCatalog.find(recipe => recipe.recipe_id === id)).filter(Boolean) as RecipeSummary[], [selectedIds])
  const visibleRecipes = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized ? recipeCatalog.filter(recipe => `${recipe.name}${recipe.preview}`.toLowerCase().includes(normalized)) : recipeCatalog
  }, [query])

  function toggleRecipe(recipe: RecipeSummary) {
    setValidationErrors([])
    setSelectedIds(current => current.includes(recipe.recipe_id) ? current.filter(id => id !== recipe.recipe_id) : current.length < 5 ? [...current, recipe.recipe_id] : current)
  }

  async function continueToKitchen() {
    const result = await validateProductRequest({ recipe_ids: selectedIds, kitchen })
    setValidationErrors(result.errors)
    setWarnings(result.warnings)
    if (result.valid) setStep('kitchen')
  }

  async function continueToConfirm() {
    const result = await validateProductRequest({ recipe_ids: selectedIds, kitchen })
    setValidationErrors(result.errors)
    setWarnings(result.warnings)
    if (result.valid) setStep('confirm')
  }

  async function createSchedule() {
    setLoading(true)
    setValidationErrors([])
    const result = await createMockSchedule({ recipe_ids: selectedIds, kitchen })
    setWarnings(result.validation.warnings)
    setValidationErrors(result.validation.errors)
    if (result.validation.valid) { setSchedule(result.schedule); setStep('result') }
    setLoading(false)
  }

  if (step === 'result' && schedule) return <ExecutionDashboard initialSchedule={schedule} />

  return <main className="product-shell">
    <header className="product-topbar"><div className="brand"><div className="brand-mark">灶</div><div><strong>灶序</strong><span>COOKFLOW AGENT</span></div></div><div className="product-status"><span className="status-dot" />厨房 A · 智能排程助手</div></header>
    <section className="product-content">
      <div className="product-heading"><div><p className="eyebrow">SMART COOKING PLANNER / V1</p><h1>从选菜开始，安排一场准时的晚餐。</h1><p className="subtitle">灶序会根据菜品、设备和目标开饭时间，生成可执行的烹饪排程。</p></div><div className="selection-count"><strong>{selected.length}</strong><span>/ 5 道菜已选</span></div></div>
      <nav className="stepper" aria-label="排程创建步骤">{[['recipes', '01', '选择菜谱'], ['kitchen', '02', '配置厨房'], ['confirm', '03', '解析确认'], ['result', '04', '查看排程']].map(([key, number, label], index) => <button key={key} className={`${step === key ? 'active' : ''} ${['recipes', 'kitchen', 'confirm', 'result'].indexOf(step) > index ? 'done' : ''}`} onClick={() => key !== 'result' && setStep(key as ProductStep)}><b>{number}</b><span>{label}</span></button>)}</nav>
      {validationErrors.length > 0 && <div className="product-alert error-banner">⚠ {validationErrors.map(error => <span key={error}>{error}</span>)}</div>}
      {warnings.length > 0 && <div className="product-alert warning-banner">△ {warnings.map(warning => <span key={warning}>{warning}</span>)}</div>}
      {step === 'recipes' && <section className="planner-grid"><div className="planner-main"><div className="section-toolbar"><div><p className="eyebrow">RECIPE LIBRARY</p><h2>选择今天要做的菜</h2></div><label className="search-box">⌕<input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索菜名或步骤" /></label></div><div className="recipe-grid">{visibleRecipes.map(recipe => <button key={recipe.recipe_id} className={`recipe-card ${selectedIds.includes(recipe.recipe_id) ? 'selected' : ''}`} onClick={() => toggleRecipe(recipe)}><span className="recipe-check">{selectedIds.includes(recipe.recipe_id) ? '✓' : '+'}</span><div><strong>{recipe.name}</strong><small>{recipe.step_count} 个步骤 · {recipe.tags.join(' · ')}</small><p>{recipe.preview}</p></div></button>)}</div></div><aside className="selection-panel"><p className="eyebrow">SELECTED DISHES</p><h2>本次排程</h2>{selected.length ? selected.map((recipe, index) => <div className="selected-recipe" key={recipe.recipe_id}><span>{String(index + 1).padStart(2, '0')}</span><div><b>{recipe.name}</b><small>{recipe.step_count} 个步骤</small></div><button onClick={() => toggleRecipe(recipe)}>×</button></div>) : <p className="empty-state">请选择 3～5 道菜</p>}<button className="primary wide" disabled={selected.length < 3} onClick={() => void continueToKitchen()}>下一步：配置厨房 →</button></aside></section>}
      {step === 'kitchen' && <KitchenStep kitchen={kitchen} setKitchen={setKitchen} onBack={() => setStep('recipes')} onNext={() => void continueToConfirm()} selected={selected} />}
      {step === 'confirm' && <ConfirmStep kitchen={kitchen} selected={selected} onBack={() => setStep('kitchen')} onSubmit={() => void createSchedule()} loading={loading} />}
    </section>
  </main>
}

function KitchenStep({ kitchen, setKitchen, onBack, onNext, selected }: { kitchen: KitchenConfig; setKitchen: (value: KitchenConfig) => void; onBack: () => void; onNext: () => void; selected: RecipeSummary[] }) {
  const update = (key: keyof KitchenConfig, value: string) => setKitchen({ ...kitchen, [key]: key === 'target_time' ? value : Number(value) })
  return <section className="setup-grid"><div className="setup-main"><p className="eyebrow">KITCHEN CONFIGURATION</p><h2>告诉我你的厨房现在有什么</h2><p className="setup-copy">排程 Agent 会把设备能力和操作员数量作为硬约束，不会安排无法执行的任务。</p><div className="config-card"><label>目标开饭时间<input type="time" value={kitchen.target_time} onChange={event => update('target_time', event.target.value)} /></label><label>操作员人数<input type="number" min="1" max="4" value={kitchen.operator_count} onChange={event => update('operator_count', event.target.value)} /></label><label>灶眼数量<input type="number" min="0" max="8" value={kitchen.stove_count} onChange={event => update('stove_count', event.target.value)} /></label><label>蒸箱数量<input type="number" min="0" max="4" value={kitchen.steamer_count} onChange={event => update('steamer_count', event.target.value)} /></label><label>烤箱数量<input type="number" min="0" max="4" value={kitchen.oven_count} onChange={event => update('oven_count', event.target.value)} /></label></div><div className="setup-actions"><button className="secondary" onClick={onBack}>← 返回选菜</button><button className="primary" onClick={onNext}>下一步：解析确认 →</button></div></div><aside className="selection-panel"><p className="eyebrow">PLAN INPUT</p><h2>{selected.length} 道菜</h2>{selected.map(recipe => <div className="selected-recipe compact" key={recipe.recipe_id}><span>✓</span><div><b>{recipe.name}</b><small>{recipe.step_count} 个步骤</small></div></div>)}</aside></section>
}

function ConfirmStep({ kitchen, selected, onBack, onSubmit, loading }: { kitchen: KitchenConfig; selected: RecipeSummary[]; onBack: () => void; onSubmit: () => void; loading: boolean }) {
  return <section className="confirm-grid"><div className="confirm-main"><p className="eyebrow">PARSER REVIEW</p><h2>确认菜谱解析结果</h2><p className="setup-copy">当前展示的是 V1 菜谱解析确认卡。低置信字段在提交前需要人工确认，避免把错误输入交给调度器。</p>{selected.map(recipe => <article className="parse-card" key={recipe.recipe_id}><div><strong>{recipe.name}</strong><span className="parse-status">待确认</span></div><p>步骤 1：{recipe.preview}</p><small>共 {recipe.step_count} 个原始步骤 · 设备能力将在调度校验阶段再次检查</small></article>)}</div><aside className="selection-panel summary-panel"><p className="eyebrow">SCHEDULE SUMMARY</p><h2>准备生成排程</h2><div className="summary-row"><span>目标开饭</span><b>{kitchen.target_time}</b></div><div className="summary-row"><span>操作员</span><b>{kitchen.operator_count} 人</b></div><div className="summary-row"><span>设备</span><b>{kitchen.stove_count} 灶 · {kitchen.steamer_count} 蒸箱 · {kitchen.oven_count} 烤箱</b></div><div className="setup-actions"><button className="secondary" onClick={onBack}>← 返回配置</button><button className="primary wide" disabled={loading} onClick={onSubmit}>{loading ? '排程计算中…' : '生成初始排程 →'}</button></div></aside></section>
}
