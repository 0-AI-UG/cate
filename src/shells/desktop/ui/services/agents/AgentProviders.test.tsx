import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import { AgentProviders } from './AgentProviders'
import type { AgentProviderInfo } from '@services/agents/contract'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const disposals: (() => void)[] = []
afterEach(() => { for (const dispose of disposals.splice(0)) dispose() })
async function render(providers: AgentProviderInfo[] = []) {
  const providerSave = vi.fn(async () => providers[0])
  const providerModels = vi.fn(async () => [{ id: 'discovered' }])
  const providerRemove = vi.fn(async () => ({ ok: true }))
  const stop = setRuntimeResolver(() => ({ agents: { providerSave, providerModels, providerRemove } }) as never)
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  disposals.push(() => { act(() => root.unmount()); host.remove(); stop() })
  await act(async () => root.render(<AgentProviders workspaceId="providers" providers={providers} />))
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text || b.getAttribute('aria-label') === text)!
  const input = async (selector: string, value: string) => act(async () => {
    const label = [...host.querySelectorAll<HTMLElement>('[id]')].find((node) => node.textContent === selector)
    const node = label ? host.querySelector<HTMLInputElement>(`input[aria-labelledby="${label.id}"]`)! : host.querySelector<HTMLInputElement>(selector)!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const submit = async () => act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  return { host, button, input, submit, providerSave, providerModels, providerRemove }
}
it('saves a manual provider and clears the write-only credential after saving', async () => {
  const f = await render()
  await act(async () => f.button('Add provider').click())
  await f.input('Name', 'My provider')
  await f.input('API base URL', 'https://example.com/custom/v1')
  await f.input('input[type="password"]', 'private-key')
  await f.input('Model 1 ID', 'manual-model')
  await f.submit()
  expect(f.providerSave).toHaveBeenCalledWith({ name: 'My provider', baseUrl: 'https://example.com/custom/v1', api: 'chat-completions', apiKey: 'private-key', models: [{ id: 'manual-model' }] })
  expect(f.host.querySelector('input[type="password"]')).toBeNull()
  expect(f.providerModels).not.toHaveBeenCalled()
})
it('edits metadata without reading the saved key and keeps manual models when discovery fails', async () => {
  const p: AgentProviderInfo = { id: 'saved', name: 'Saved', baseUrl: 'https://example.com/v1', api: 'responses', hasKey: true, models: [{ id: 'manual' }] }
  const f = await render([p])
  await act(async () => f.button('Edit Saved').click())
  expect(f.host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('')
  f.providerModels.mockRejectedValueOnce(new Error('Enter model IDs manually.'))
  await act(async () => f.button('Load models').click())
  expect(f.host.textContent).toContain('Enter model IDs manually.')
  expect([...f.host.querySelectorAll<HTMLInputElement>('input')].some((input) => input.value === 'manual')).toBe(true)
  await f.submit()
  expect(f.providerSave).toHaveBeenCalledWith({ id: p.id, name: p.name, baseUrl: p.baseUrl, api: p.api, models: p.models })
})
it('adds discovered models without losing manual model limits', async () => {
  const p: AgentProviderInfo = { id: 'saved', name: 'Saved', baseUrl: 'https://example.com/v1', api: 'responses', hasKey: true, models: [{ id: 'manual', maxInputTokens: 64000 }] }
  const f = await render([p])
  await act(async () => f.button('Edit Saved').click())
  await act(async () => f.button('Load models').click())
  await f.submit()
  expect(f.providerSave).toHaveBeenCalledWith(expect.objectContaining({ models: [{ id: 'manual', maxInputTokens: 64000 }, { id: 'discovered' }] }))
})
