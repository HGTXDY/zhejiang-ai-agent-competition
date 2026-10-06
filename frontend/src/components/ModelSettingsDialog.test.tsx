import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ModelSettingsDialog from './ModelSettingsDialog'
import type { ModelSettings } from '../api/product'

const settings: ModelSettings = {
  parser_provider: 'deterministic',
  configured: false,
  ready: false,
  base_url: null,
  model: 'gpt-4o-mini',
  api_key_masked: null,
  source: 'runtime',
  notes: [],
}

const props = () => ({
  open: true,
  settings,
  busy: false,
  onClose: vi.fn(),
  onSave: vi.fn().mockResolvedValue(undefined),
  onTest: vi.fn().mockResolvedValue('连接成功'),
  onReset: vi.fn().mockResolvedValue(undefined),
})

afterEach(() => {
  cleanup()
  document.body.style.overflow = ''
})

it('keeps model fields inactive for deterministic parsing and enables them for AI parsing', () => {
  render(<ModelSettingsDialog {...props()} />)
  expect(screen.getByLabelText(/^服务地址/)).toBeDisabled()
  expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled()

  fireEvent.click(screen.getByText('智能模式'))
  expect(screen.getByLabelText(/^服务地址/)).toBeEnabled()
  expect(screen.getByLabelText(/^服务模型/)).toBeEnabled()
  expect(screen.getByLabelText(/^访问密钥/)).toBeEnabled()
})

it('locks page scrolling and closes with Escape', async () => {
  const dialogProps = props()
  const { unmount } = render(<ModelSettingsDialog {...dialogProps} />)
  await waitFor(() => expect(document.body.style.overflow).toBe('hidden'))

  fireEvent.keyDown(document, { key: 'Escape' })
  expect(dialogProps.onClose).toHaveBeenCalledOnce()

  unmount()
  expect(document.body.style.overflow).toBe('')
})
