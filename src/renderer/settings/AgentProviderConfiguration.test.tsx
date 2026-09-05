// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SettingsSearchContext } from './SettingsSearchContext'
import { AgentProviderConfiguration } from './AgentProviderConfiguration'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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


it('saves multiline launch arguments as the string required by the T3 settings RPC', async () => {
  const operate = vi.fn().mockResolvedValue({ settings: { providers: { codex: { enabled: true, launchArgs: '' } } }, providers: [] })
  const changed = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { agentProviderSettings: operate } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<AgentProviderConfiguration workspaceId="ws" cwd="/repo" onChanged={changed} authentication={() => null} />))
    const input = host.querySelector('textarea[aria-label="Launch arguments"]')!
    const args = '--config\nmodel_reasoning_effort="low"'
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, args)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Save provider')!.click())
    const save = operate.mock.calls.find(([request]) => request.operation === 'save')![0]
    expect(save.patch.providers.codex.launchArgs).toBe(args)
    expect(save.patch.providerInstances.codex.config.launchArgs).toBe(args)
    expect(changed).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('keeps advanced settings collapsed and changes only the viewed provider when selecting', async () => {
  const operate = vi.fn().mockResolvedValue({ settings: { providers: {}, providerInstances: {} }, providers: [] })
  const changed = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { agentProviderSettings: operate } })
  const host = document.createElement('div')
  const root = createRoot(host)
  const render = (query = '') => <SettingsSearchContext.Provider value={{ query, sectionMatched: false }}>
    <AgentProviderConfiguration workspaceId="ws" cwd="/repo" onChanged={changed} authentication={(driver) => <p>Account for {driver}</p>} />
  </SettingsSearchContext.Provider>
  try {
    await act(async () => root.render(render()))
    expect([...host.querySelectorAll('details')].map((details) => details.open)).toEqual([false, false, false])
    expect(host.textContent).toContain('Selection only changes the settings shown below')
    const provider = host.querySelector('button[aria-label="Configure Claude Code"]') as HTMLButtonElement
    await act(async () => provider.click())
    expect(provider.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1)
    expect(host.textContent).toContain('Account for claudeAgent')
    expect(host.textContent).not.toContain('Account for codex')
    expect(operate).toHaveBeenCalledTimes(1)
    expect(operate).toHaveBeenCalledWith(expect.objectContaining({ operation: 'read' }))
    expect(changed).not.toHaveBeenCalled()
    await act(async () => root.render(render('binary path')))
    expect([...host.querySelectorAll('details')].every((details) => details.open)).toBe(true)
    expect(host.textContent).toContain('Binary path')
    await act(async () => root.render(render()))
    expect([...host.querySelectorAll('details')].every((details) => !details.open)).toBe(true)
  } finally {
    await act(async () => root.unmount())
  }
})

it('keeps failed edits retryable and discards them without saving or changing another account', async () => {
  const settings = { providers: { codex: { enabled: true, launchArgs: '--original' } }, providerInstances: {} }
  const operate = vi.fn().mockResolvedValue({ settings, providers: [] })
  const changed = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { agentProviderSettings: operate } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<AgentProviderConfiguration workspaceId="ws" cwd="/repo" onChanged={changed} authentication={() => null} />))
    const button = (label: string) => [...host.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label)!
    const input = host.querySelector('textarea[aria-label="Launch arguments"]') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '--edited')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(button('Configure Claude Code').matches(':disabled')).toBe(true)
    expect(button('Refresh').matches(':disabled')).toBe(true)
    operate.mockResolvedValueOnce({ error: 'Fixture save rejected' })
    await act(async () => button('Save provider').click())
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Fixture save rejected')
    expect(input.value).toBe('--edited')
    expect(button('Save provider').matches(':disabled')).toBe(false)
    expect(changed).not.toHaveBeenCalled()
    await act(async () => button('Discard').click())
    expect(input.value).toBe('--original')
    expect(button('Configure Claude Code').matches(':disabled')).toBe(false)
    expect(operate.mock.calls.filter(([request]) => request.operation === 'save')).toHaveLength(1)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it.each([
  { driver: 'claudeAgent', name: 'Claude Code', label: 'Auto-compact after (tokens)', key: 'autoCompactWindow', input: '64000', expected: 64000 },
  { driver: 'cursor', name: 'Cursor', label: 'API endpoint', key: 'apiEndpoint', input: 'https://fixture.invalid/api', expected: 'https://fixture.invalid/api' },
  { driver: 'grok', name: 'Grok', label: 'Binary path', key: 'binaryPath', input: '/fixture/grok', expected: '/fixture/grok' },
  { driver: 'opencode', name: 'OpenCode', label: 'Server password', key: 'serverPassword', input: 'synthetic-password', expected: 'synthetic-password' },
])('serializes $name configuration without replacing another account', async ({ driver, name, label, key, input, expected }) => {
  const sibling = { driver: 'codex', displayName: 'Other account', enabled: false, config: { binaryPath: '/other/codex' } }
  const operate = vi.fn().mockResolvedValue({ settings: { providers: {}, providerInstances: { sibling } }, providers: [] })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { agentProviderSettings: operate } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<AgentProviderConfiguration workspaceId="ws" cwd="/repo" onChanged={async () => {}} authentication={() => null} />))
    await act(async () => (host.querySelector(`button[aria-label="Configure ${name}"]`) as HTMLButtonElement).click())
    const field = [...host.querySelectorAll('input')].find(element => document.getElementById(element.getAttribute('aria-labelledby') ?? '')?.textContent === label)!
    expect(field).toBeDefined()
    if (key === 'serverPassword') expect(field.type).toBe('password')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, input)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Save provider')!.click())
    const patch = operate.mock.calls.find(([request]) => request.operation === 'save')![0].patch
    expect(patch.providers).toEqual({ [driver]: expect.objectContaining({ [key]: expected }) })
    expect(patch.providerInstances[driver].config[key]).toBe(expected)
    expect(patch.providerInstances.sibling).toEqual(sibling)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
