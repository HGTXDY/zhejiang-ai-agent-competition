import { useState } from 'react'
import { draftToKitchen, interpretAgentMessage } from '../api/agent'
import type { AgentPlanDraft, AgentPlanResponse, KitchenConfig, RecipeSummary } from '../types/product'

interface Message { role: 'agent' | 'user'; text: string }
interface Props { catalog: RecipeSummary[]; defaultKitchen: KitchenConfig; loading: boolean; modelReady: boolean; offlineDemo: boolean; onOpenSettings: () => void; onBack: () => void; onConfirm: (ids: string[], kitchen: KitchenConfig) => Promise<void> }
const example = '晚上六点半开饭，我一个人，做苹果芒果派、香烤排骨和麻辣对虾，有一个灶、一个蒸箱和一个烤箱。'

export default function AgentPlanner({ catalog, defaultKitchen, loading, modelReady, offlineDemo, onOpenSettings, onBack, onConfirm }: Props) {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([{ role: 'agent', text: '你好，我是灶序。告诉我想做什么、几点开饭，以及厨房里有哪些设备。' }])
  const [result, setResult] = useState<AgentPlanResponse | null>(null)
  const [busy, setBusy] = useState(false)
  async function send(text = input) {
    const message = text.trim(); if (!message || busy || !modelReady) return
    setMessages(current => [...current, { role: 'user', text: message }]); setInput(''); setBusy(true)
    try { const next = await interpretAgentMessage(message, catalog, result?.draft); setResult(next); setMessages(current => [...current, { role: 'agent', text: next.reply }]) }
    catch { setMessages(current => [...current, { role: 'agent', text: '理解失败了，请检查服务连接后重试。' }]) }
    finally { setBusy(false) }
  }
  const draft = result?.draft
  return <section className="agent-workspace">
    <div className="agent-chat-card">
      <div className="agent-card-head"><button className="text-back" onClick={onBack}>← 选择其他方式</button><span><i /> 智能规划在线</span></div>
      <div className={`agent-model-notice ${modelReady ? 'ready' : ''}`}><span aria-hidden="true">✦</span><div><b>如果使用此功能，请先到右上角的设置配置大模型哦！</b><small>{modelReady ? '大模型已经连接，可以开始对话。' : offlineDemo ? '当前是离线演示模式，请使用 HTTP 模式启动后再配置。' : '配置并测试成功后，智能对话才会启用。'}</small></div>{!modelReady && <button type="button" onClick={onOpenSettings}>去设置</button>}</div>
      <div className="agent-messages" aria-live="polite">{messages.map((message, index) => <div key={index} className={`agent-message ${message.role}`}><span>{message.role === 'agent' ? '灶序' : '你'}</span><p>{message.text}</p></div>)}</div>
      {messages.length === 1 && <button className="example-prompt" disabled={!modelReady} onClick={() => void send(example)}>试试示例：{example}</button>}
      <form className="agent-composer" onSubmit={event => { event.preventDefault(); void send() }}><textarea aria-label="告诉智能助手你的做饭需求" disabled={!modelReady} value={input} onChange={event => setInput(event.target.value)} placeholder="例如：今晚 6:30 开饭，做三道菜……" /><button disabled={!modelReady || !input.trim() || busy}>{busy ? '理解中' : '发送 ↑'}</button></form>
    </div>
    <aside className="agent-understanding">
      <p className="eyebrow">理解与工具调用</p><h2>{result ? '请确认我理解得对不对' : '说完需求，我来安排'}</h2>
      {!result ? <div className="agent-empty"><b>我会自动完成</b><ol><li>识别菜单与开饭时间</li><li>追问缺失的厨房条件</li><li>匹配官方菜谱并检查设备</li><li>调用调度器生成无冲突计划</li></ol></div> : <>
        <div className="understanding-grid"><div><span>开饭时间</span><b>{draft?.target_time ?? '待补充'}</b></div><div><span>做饭人数</span><b>{draft?.operator_count ? `${draft.operator_count} 人` : '待补充'}</b></div><div className="wide"><span>菜单</span><b>{draft?.recipes.length ? draft.recipes.map(item => item.name).join('、') : '待补充 3～5 道菜'}</b></div><div className="wide"><span>厨房设备</span><b>灶 {draft?.devices.stove_count ?? '？'} · 蒸箱 {draft?.devices.steamer_count ?? '？'} · 烤箱 {draft?.devices.oven_count ?? '？'}</b></div></div>
        <div className="tool-trace">{result.tool_trace.map(item => <div className={item.status} key={item.name}><span>{item.status === 'completed' ? '✓' : '·'}</span>{item.label}</div>)}</div>
        {result.missing_fields.length > 0 && <p className="agent-missing">还需要补充信息，请直接在左侧继续回答。</p>}
        <button className="primary wide" disabled={!result.ready_to_confirm || loading} onClick={() => draft && void onConfirm(draft.recipes.map(item => item.recipe_id), draftToKitchen(draft, defaultKitchen))}>{loading ? '正在调用工具…' : '确认并生成计划 →'}</button>
      </>}
    </aside>
  </section>
}
