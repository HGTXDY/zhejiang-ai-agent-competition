import { useEffect, useState } from 'react'
import type { ModelSettings, ModelSettingsUpdate, ParserProvider } from '../api/product'

interface Props {
  open: boolean
  settings: ModelSettings
  busy: boolean
  onClose: () => void
  onSave: (payload: ModelSettingsUpdate) => Promise<void>
  onTest: (payload: ModelSettingsUpdate) => Promise<string>
  onReset: () => Promise<void>
}

export default function ModelSettingsDialog({ open, settings, busy, onClose, onSave, onTest, onReset }: Props) {
  const [provider, setProvider] = useState<ParserProvider>(settings.parser_provider)
  const [baseUrl, setBaseUrl] = useState(settings.base_url ?? '')
  const [model, setModel] = useState(settings.model)
  const [apiKey, setApiKey] = useState('')
  const [feedback, setFeedback] = useState('')

  useEffect(() => {
    if (!open) return
    setProvider(settings.parser_provider)
    setBaseUrl(settings.base_url ?? '')
    setModel(settings.model)
    setApiKey('')
    setFeedback('')
  }, [open, settings])

  if (!open) return null
  const payload = (): ModelSettingsUpdate => ({
    parser_provider: provider,
    base_url: baseUrl,
    model,
    ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
  })

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="model-dialog" role="dialog" aria-modal="true" aria-labelledby="model-settings-title">
      <div className="dialog-heading">
        <div><p className="eyebrow">MODEL CONFIGURATION</p><h2 id="model-settings-title">模型与解析设置</h2></div>
        <button type="button" className="icon-button" aria-label="关闭模型设置" onClick={onClose}>×</button>
      </div>
      <div className="model-safety-note"><b>职责边界</b><span>模型只解析菜谱语义；字段校验、设备约束和 CP-SAT 排程不会交给模型。</span></div>
      <fieldset className="provider-options" disabled={busy}>
        <legend>菜谱解析方式</legend>
        <label className={provider === 'deterministic' ? 'selected' : ''}>
          <input type="radio" name="parser-provider" checked={provider === 'deterministic'} onChange={() => setProvider('deterministic')} />
          <span><b>规则解析</b><small>默认且稳定，不需要外部模型</small></span>
        </label>
        <label className={provider === 'llm' ? 'selected' : ''}>
          <input type="radio" name="parser-provider" checked={provider === 'llm'} onChange={() => setProvider('llm')} />
          <span><b>AI 增强解析</b><small>OpenAI-compatible Chat Completions</small></span>
        </label>
      </fieldset>
      <div className="model-form">
        <label>Base URL<input disabled={busy} value={baseUrl} placeholder="https://api.openai.com/v1" onChange={event => setBaseUrl(event.target.value)} /></label>
        <label>模型名称<input disabled={busy} value={model} placeholder="gpt-4o-mini" onChange={event => setModel(event.target.value)} /></label>
        <label>API Key<input disabled={busy} type="password" autoComplete="off" value={apiKey} placeholder={settings.api_key_masked ?? '输入 API Key'} onChange={event => setApiKey(event.target.value)} /><small>{settings.api_key_masked ? '留空将保留当前密钥' : '密钥只发送到本机后端，不写入浏览器存储'}</small></label>
      </div>
      <div className={`model-status ${settings.ready ? 'ready' : ''}`}>
        <span>{settings.ready ? '● 已配置' : '○ 未配置'}</span><small>{settings.source === 'environment' ? '来自环境变量' : '当前服务进程'}</small>
      </div>
      {feedback && <p className="dialog-feedback" role="status">{feedback}</p>}
      <div className="dialog-actions">
        <button className="text-button danger" disabled={busy} onClick={() => void onReset().then(() => setFeedback('已恢复环境变量默认配置'))}>恢复默认</button>
        <span />
        <button className="secondary" disabled={busy || !baseUrl || !model || (!apiKey && !settings.configured)} onClick={() => void onTest(payload()).then(setFeedback).catch(error => setFeedback(error instanceof Error ? error.message : '连接失败'))}>测试连接</button>
        <button className="primary" disabled={busy} onClick={() => void onSave(payload()).then(onClose).catch(error => setFeedback(error instanceof Error ? error.message : '保存失败'))}>保存设置</button>
      </div>
    </section>
  </div>
}
