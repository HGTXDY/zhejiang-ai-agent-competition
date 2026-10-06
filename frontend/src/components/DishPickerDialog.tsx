import { useEffect, useMemo, useState } from 'react'
import type { RecipeSummary } from '../types/product'

interface DishPickerDialogProps {
  recipes: RecipeSummary[]
  existingDishIds: Set<string>
  loading?: boolean
  onClose: () => void
  onConfirm: (recipe: RecipeSummary) => void
}

export default function DishPickerDialog({ recipes, existingDishIds, loading = false, onClose, onConfirm }: DishPickerDialogProps) {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const visibleRecipes = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return recipes
    return recipes.filter(recipe => `${recipe.name} ${recipe.preview} ${recipe.tags.join(' ')}`.toLowerCase().includes(normalized))
  }, [query, recipes])
  const selected = recipes.find(recipe => recipe.recipe_id === selectedId)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !loading) onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [loading, onClose])

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !loading) onClose() }}>
    <section className="model-dialog dish-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="dish-picker-title">
      <div className="dialog-heading dish-picker-header">
        <div><p className="eyebrow">调整当前排程</p><h2 id="dish-picker-title">临时加菜</h2><p>选一道菜加入现在的做饭安排，系统会尽量少打乱已排好的步骤。</p></div>
        <button type="button" className="dialog-close" aria-label="关闭临时加菜" onClick={onClose} disabled={loading}>×</button>
      </div>
      <div className="dish-picker-toolbar"><label className="dish-picker-search"><span aria-hidden="true">⌕</span><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索菜名或做法" aria-label="搜索菜名或做法" /></label><span>{visibleRecipes.length} 道可选</span></div>
      <div className="dish-picker-grid" aria-live="polite">
        {visibleRecipes.map(recipe => {
          const alreadyAdded = existingDishIds.has(recipe.recipe_id)
          const selectedCard = selectedId === recipe.recipe_id
          return <button type="button" className={`dish-picker-card ${selectedCard ? 'selected' : ''} ${alreadyAdded ? 'disabled' : ''}`} key={recipe.recipe_id} disabled={alreadyAdded || loading} aria-pressed={selectedCard} onClick={() => setSelectedId(recipe.recipe_id)}>
            <span className="recipe-check" aria-hidden="true">{selectedCard ? '✓' : ''}</span><span className="dish-picker-card-copy"><strong>{recipe.name}</strong><small>{recipe.step_count} 个步骤 · {alreadyAdded ? '已在当前计划' : '可加入'}</small><p>{recipe.preview}</p><span className="dish-picker-tags">{recipe.tags.slice(0, 2).map(tag => <em key={tag}>{tag}</em>)}</span></span>
          </button>
        })}
        {!visibleRecipes.length && <p className="dish-picker-empty">没有找到匹配的菜，换个关键词试试。</p>}
      </div>
      <div className="dialog-actions dish-picker-actions"><button type="button" className="secondary" onClick={onClose} disabled={loading}>取消</button><button type="button" className="primary" disabled={!selected || loading} onClick={() => selected && onConfirm(selected)}>{loading ? '正在调整…' : '加入排程'}</button></div>
    </section>
  </div>
}
