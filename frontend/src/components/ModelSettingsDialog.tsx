import { useEffect, useRef, useState } from 'react'
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

type PendingAction = 'save' | 'test' | 'reset' | null

export default function ModelSettingsDialog({ open, settings, busy, onClose, onSave, onTest, onReset }: Props) {
  const [provider, setProvider] = useState<ParserProvider>(settings.parser_provider)
  const [baseUrl, setBaseUrl] = useState(settings.base_url ?? '')
  const [model, setModel] = useState(settings.model)
  const [apiKey, setApiKey] = useState('')
  const [feedback, setFeedback] = useState('')
  const [feedbackType, setFeedbackType] = useState<'success' | 'error'>('success')
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const busyRef = useRef(busy)
  const onCloseRef = useRef(onClose)
  busyRef.current = busy
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    setProvider(settings.parser_provider)
    setBaseUrl(settings.base_url ?? '')
    setModel(settings.model)
    setApiKey('')
    setFeedback('')
    setPendingAction(null)
  }, [open, settings])

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) onCloseRef.current()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  if (!open) return null
  const payload = (): ModelSettingsUpdate => ({
    parser_provider: provider,
    base_url: baseUrl.trim(),
    model: model.trim(),
    ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
  })
  const canConnect = Boolean(baseUrl.trim() && model.trim() && (apiKey.trim() || settings.configured))

  async function perform(action: Exclude<PendingAction, null>, task: () => Promise<string | void>) {
    setPendingAction(action)
    setFeedback('')
    try {
      const message = await task()
      setFeedbackType('success')
      setFeedback(message || '操作成功')
      return true
    } catch (error) {
      setFeedbackType('error')
      setFeedback(error instanceof Error ? error.message : '操作失败，请检查配置后重试')
      return false
    } finally {
      setPendingAction(null)
    }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="model-dialog" role="dialog" aria-modal="true" aria-labelledby="model-settings-title" aria-describedby="model-settings-description">
      <div className="dialog-heading">
        <div><p className="eyebrow">MODEL CONFIGURATION</p><h2 id="model-settings-title">模型与解析设置</h2><p id="model-settings-description">选择解析引擎，并配置兼容 OpenAI 接口的模型服务。</p></div>
        <button ref={closeButtonRef} type="button" className="icon-button" aria-label="关闭模型设置" disabled={busy} onClick={onClose}>×</button>
      </div>
      <div className="dialog-scroll-area">
        <div className="model-safety-note"><span aria-hidden="true">✓</span><div><b>模型的职责边界</b><p>仅用于理解菜谱语义；字段校验、设备约束与 CP-SAT 排程仍由确定性逻辑负责。</p></div></div>
        <fieldset className="provider-options" disabled={busy}>
          <legend>菜谱解析方式</legend>
          <label className={provider === 'deterministic' ? 'selected' : ''}>
            <input type="radio" name="parser-provider" checked={provider === 'deterministic'} onChange={() => setProvider('deterministic')} />
            <span><b>规则解析</b><small>开箱即用、结果稳定，不需要外部模型</small></span>
          </label>
          <label className={provider === 'llm' ? 'selected' : ''}>
            <input type="radio" name="parser-provider" checked={provider === 'llm'} onChange={() => setProvider('llm')} />
            <span><b>AI 增强解析</b><small>调用 OpenAI-compatible Chat Completions</small></span>
          </label>
        </fieldset>
        <div className={`model-form ${provider === 'deterministic' ? 'muted' : ''}`} aria-disabled={provider === 'deterministic'}>
          <label>Base URL<input disabled={busy || provider === 'deterministic'} inputMode="url" value={baseUrl} placeholder="https://api.openai.com/v1" onChange={event => setBaseUrl(event.target.value)} /><small>填写服务根地址，无需附加 chat/completions。</small></label>
          <label>模型名称<input disabled={busy || provider === 'deterministic'} value={model} placeholder="gpt-4o-mini" onChange={event => setModel(event.target.value)} /><small>使用服务商支持的精确模型 ID。</small></label>
          <label>API Key<input disabled={busy || provider === 'deterministic'} type="password" autoComplete="new-password" value={apiKey} placeholder={settings.api_key_masked ?? '输入 API Key'} onChange={event => setApiKey(event.target.value)} /><small>{settings.api_key_masked ? `当前密钥 ${settings.api_key_masked}，留空将继续使用` : '密钥仅发送到本机后端，不写入浏览器存储'}</small></label>
        </div>
        <div className={`model-status ${provider === 'deterministic' || settings.ready ? 'ready' : ''}`}>
          <span><i aria-hidden="true" />{settings.ready ? '模型服务已就绪' : provider === 'deterministic' ? '当前使用规则解析' : '模型服务尚未就绪'}</span><small>{settings.source === 'environment' ? '配置来自环境变量' : '配置仅在当前服务进程生效'}</small>
        </div>
        {feedback && <p className={`dialog-feedback ${feedbackType}`} role={feedbackType === 'error' ? 'alert' : 'status'}>{feedback}</p>}
      </div>
      <div className="dialog-actions">
        <button className="text-button danger" disabled={busy} onClick={() => void perform('reset', async () => { await onReset(); return '已恢复环境变量默认配置' })}>{pendingAction === 'reset' ? '恢复中…' : '恢复默认'}</button>
        <span />
        <button className="secondary" disabled={busy || provider === 'deterministic' || !canConnect} onClick={() => void perform('test', () => onTest(payload()))}>{pendingAction === 'test' ? '测试中…' : '测试连接'}</button>
        <button className="primary" disabled={busy || (provider === 'llm' && !canConnect)} onClick={() => void perform('save', async () => { await onSave(payload()); return '设置已保存' }).then(success => { if (success) onClose() })}>{pendingAction === 'save' ? '保存中…' : '保存设置'}</button>
      </div>
    </section>
  </div>
}
