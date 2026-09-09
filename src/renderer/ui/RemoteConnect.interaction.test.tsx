import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RemoteConnect } from './RemoteConnect'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  Object.assign(window.electronAPI, {
    runtimeWslDistros: vi.fn().mockResolvedValue([]),
    runtimeSshHosts: vi.fn().mockResolvedValue([{ alias: 'production', host: 'resolved.example' }]),
    runtimePickSshKey: vi.fn().mockResolvedValue(null),
  })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
function button(label: string) { return [...host.querySelectorAll('button')].find((b) => b.textContent === label)! }
function change(label: string, value: string) {
  const el = [...host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].find((input) => document.getElementById(input.getAttribute('aria-labelledby') ?? '')?.textContent === label)!
  const prototype = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}
it('submits an SSH config alias unchanged and preserves saved agent preference', async () => {
  const submit = vi.fn()
  await act(async () => root.render(<RemoteConnect initial={{ host: 'old', remotePath: '/project' }} onSubmit={submit} />))
  act(() => change('SSH config host', 'production'))
  act(() => button('Save connection').click())
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ host: 'production', remotePath: '/project', auth: { keyPath: undefined, passphrase: undefined } }))
})
it('allows an explicit agent preference change', async () => {
  const submit = vi.fn()
  await act(async () => root.render(<RemoteConnect initial={{ host: 'host', remotePath: '/project' }} onSubmit={submit} />))
  act(() => change('SSH agent', 'disabled'))
  act(() => button('Save connection').click())
  expect(submit.mock.calls[0][0].auth.useAgent).toBe(false)
})
it('prevents malformed ports and unsupported pasted options from reaching connect', async () => {
  const submit = vi.fn()
  await act(async () => root.render(<RemoteConnect initial={{ host: 'host', remotePath: '/project' }} onSubmit={submit} />))
  for (const target of ['host:65536', 'host:abc', 'ssh -i /keys/private user@host']) {
    act(() => change('SSH host', target))
    expect(button('Save connection').disabled).toBe(true)
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
  }
  expect(submit).not.toHaveBeenCalled()
})
it('locks all fields and dismissal while a connection is pending', async () => {
  const cancel = vi.fn()
  await act(async () => root.render(<RemoteConnect pending onCancel={cancel} onSubmit={vi.fn()} />))
  expect(host.querySelector('fieldset')!.disabled).toBe(true)
  expect(button('Cancel').disabled).toBe(true)
  act(() => host.querySelector('form')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(cancel).not.toHaveBeenCalled()
})
it('reports key picker errors and allows recovery', async () => {
  vi.mocked(window.electronAPI.runtimePickSshKey).mockRejectedValue(new Error('unavailable'))
  await act(async () => root.render(<RemoteConnect onSubmit={vi.fn()} />))
  await act(async () => button('Browse…').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Enter the key path instead')
})
it('can save a WSL profile without connecting to the distribution', async () => {
  vi.mocked(window.electronAPI.runtimeWslDistros).mockResolvedValue(['Ubuntu'])
  const submit = vi.fn()
  await act(async () => root.render(<RemoteConnect initial={{ kind: 'wsl', distro: 'Removed', distroPath: '/project' }} onSubmit={submit} />))
  act(() => change('WSL distribution', 'Ubuntu'))
  act(() => button('Save connection').click())
  expect(submit).toHaveBeenCalledWith({ kind: 'wsl', distro: 'Ubuntu', distroPath: '/project' })
})
