import type { InitialRequest, ParseResult, StagedPlanResponse } from '../api/product'
import type { DashboardSchedule } from '../types/contracts'
import type { AgentPlanResponse, KitchenConfig } from '../types/product'

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
  stagedPlan: StagedPlanResponse | null
  stagedRequest: InitialRequest | null
}

export interface AgentMessage { role: 'agent' | 'user'; text: string }

export interface AgentChatState {
  messages: AgentMessage[]
  result: AgentPlanResponse | null
  input: string
}

const STORAGE_KEY = 'cookflow.session.v1'
const AGENT_CHAT_KEY = 'cookflow.agent.v1'

function isMode(value: unknown): value is SessionPlanningMode {
  return value === 'choose' || value === 'agent' || value === 'manual'
}
function isSource(value: unknown): value is SessionPlanSource {
  return value === 'agent' || value === 'manual'
}
function isStep(value: unknown): value is SessionStep {
  return value === 'recipes' || value === 'kitchen' || value === 'confirm' || value === 'result'
}
function isAgentMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return (message.role === 'agent' || message.role === 'user') && typeof message.text === 'string'
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
      stagedPlan: value.stagedPlan && typeof value.stagedPlan === 'object' ? value.stagedPlan as StagedPlanResponse : null,
      stagedRequest: value.stagedRequest && typeof value.stagedRequest === 'object' ? value.stagedRequest as InitialRequest : null,
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

export function loadAgentChat(): AgentChatState | null {
  try {
    const raw = localStorage.getItem(AGENT_CHAT_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || typeof value !== 'object') return null
    return {
      messages: Array.isArray(value.messages) ? value.messages.filter(isAgentMessage) : [],
      result: value.result && typeof value.result === 'object' ? value.result as AgentPlanResponse : null,
      input: typeof value.input === 'string' ? value.input : '',
    }
  } catch {
    return null
  }
}

export function saveAgentChat(state: AgentChatState) {
  try { localStorage.setItem(AGENT_CHAT_KEY, JSON.stringify(state)) } catch { /* storage unavailable or quota exceeded */ }
}

export function clearAgentChat() {
  try { localStorage.removeItem(AGENT_CHAT_KEY) } catch { /* ignore */ }
}

export function clearAll() {
  clearSession()
  clearAgentChat()
}
