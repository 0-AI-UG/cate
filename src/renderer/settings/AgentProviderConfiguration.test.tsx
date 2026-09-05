// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { AgentProviderConfiguration } from './AgentProviderConfiguration'

it('uses shared accessible switches and saves the T3 instance without changing terminal settings', async () => {
  const settings = { providers: { codex: { enabled: true } }, providerInstances: {} }
  const operate = vi.fn().mockResolvedValue({ settings, providers: [] })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { agentProviderSettings: operate } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<AgentProviderConfiguration workspaceId="ws" cwd="/repo" onChanged={async () => {}} authentication={() => null} />))
    expect(host.querySelector('input[type="checkbox"]')).toBeNull()
    const enabled = host.querySelector('[role="switch"]') as HTMLButtonElement
    expect(enabled.getAttribute('aria-checked')).toBe('true')
    await act(async () => enabled.click())
    expect(enabled.getAttribute('aria-checked')).toBe('false')
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save provider')!
    await act(async () => save.click())
    expect(operate).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'save', patch: expect.objectContaining({ providers: { codex: expect.objectContaining({ enabled: false }) } }) }))
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
