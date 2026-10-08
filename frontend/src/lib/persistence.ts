import type { ParseResult } from '../api/product'
import type { DashboardSchedule } from '../types/contracts'
import type { KitchenConfig } from '../types/product'

export type SessionStep = 'recipes' | 'kitchen' | 'confirm' | 'result'
export type SessionPlanningMode = 'choose' | 'agent' | 'manual'
export type SessionPlanSource = 'agent' | 'manual'

export interface SessionState {
  planningMode: SessionPlanningMode
  planSource: SessionPlanSource
  manualFlow: boolean
  step: SessionStep
  selectedIds: string[]
  kitchen: KitchenConfig | null
  parsed: ParseResult[]
  confirmed: boolean
  schedule: DashboardSchedule | null
  executionStarted: boolean
}

const STORAGE_KEY = 'cookflow.session.v1'

function isMode(value: unknown): value is SessionPlanningMode {
  return value === 'choose' || value === 'agent' || value === 'manual'
}
function isSource(value: unknown): value is SessionPlanSource {
  return value === 'agent' || value === 'manual'
}
function isStep(value: unknown): value is SessionStep {
  return value === 'recipes' || value === 'kitchen' || value === 'confirm' || value === 'result'
}

export function loadSession(): SessionState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || typeof value !== 'object') return null
    return {
      planningMode: isMode(value.planningMode) ? value.planningMode : 'choose',
      planSource: isSource(value.planSource) ? value.planSource : 'manual',
      manualFlow: value.manualFlow === true,
      step: isStep(value.step) ? value.step : 'recipes',
      selectedIds: Array.isArray(value.selectedIds) ? value.selectedIds.filter((id): id is string => typeof id === 'string') : [],
      kitchen: value.kitchen && typeof value.kitchen === 'object' ? value.kitchen as KitchenConfig : null,
      parsed: Array.isArray(value.parsed) ? value.parsed as ParseResult[] : [],
      confirmed: value.confirmed === true,
      schedule: value.schedule && typeof value.schedule === 'object' ? value.schedule as DashboardSchedule : null,
      executionStarted: value.executionStarted === true,
    }
  } catch {
    return null
  }
}

export function saveSession(session: SessionState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)) } catch { /* storage unavailable or quota exceeded */ }
}

export function clearSession() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}
