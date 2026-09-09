import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../stores/appStore'
import { useRemoteConnectionsStore } from '../stores/remoteConnectionsStore'
import { RemoteSettings } from './RemoteSettings'
import { SettingsSearchContext } from './SettingsSearchContext'
import type { RemoteRuntimeConnection } from '../../shared/runtimeConnection'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
const initial = useRemoteConnectionsStore.getState()
const connection: RemoteRuntimeConnection = { kind: 'server', runtimeId: 'srv_test', host: 'dev', user: 'me', remotePath: '/project' }
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  Object.assign(window.electronAPI, {
    runtimeWslDistros: vi.fn().mockResolvedValue([]), runtimeSshHosts: vi.fn().mockResolvedValue([]),
    onRuntimeStatus: vi.fn(() => () => {}), runtimeEnsure: vi.fn().mockResolvedValue({ ok: true }),
  })
  useRemoteConnectionsStore.setState({ connections: [connection], loaded: true, load: vi.fn().mockResolvedValue(undefined), save: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useRemoteConnectionsStore.setState(initial, true) })
function button(label: string) { return [...host.querySelectorAll('button')].find((b) => b.textContent === label)! }
it('shows saved connections independently of open workspaces and checks them', async () => {
  await act(async () => root.render(<RemoteSettings />))
  expect(host.textContent).toContain('me@dev')
  await act(async () => button('Check connection').click())
  expect(window.electronAPI.runtimeEnsure).toHaveBeenCalledWith(connection)
  expect(host.textContent).toContain('Connected')
})
it('adds and edits inline without creating or repointing a workspace', async () => {
  const add = vi.spyOn(useAppStore.getState(), 'addWorkspace')
  const connect = vi.spyOn(useAppStore.getState(), 'connectRemoteWorkspace')
  await act(async () => root.render(<RemoteSettings />))
  await act(async () => button('Edit').click())
  expect(host.querySelector('form')).not.toBeNull()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => button('Save connection').click())
  expect(useRemoteConnectionsStore.getState().save).toHaveBeenCalledWith(expect.objectContaining({ host: 'dev', remotePath: '/project' }), 'srv_test')
  expect(add).not.toHaveBeenCalled()
  expect(connect).not.toHaveBeenCalled()
  await act(async () => button('Add connection').click())
  expect(host.querySelector('form')?.getAttribute('aria-label')).toBe('New remote connection')
  await act(async () => button('Cancel').click())
  expect(host.querySelector('form')).toBeNull()
})
it('removes only the saved profile', async () => {
  const removeWorkspace = vi.spyOn(useAppStore.getState(), 'removeWorkspace')
  await act(async () => root.render(<RemoteSettings />))
  await act(async () => button('Remove').click())
  expect(useRemoteConnectionsStore.getState().remove).toHaveBeenCalledWith('srv_test')
  expect(removeWorkspace).not.toHaveBeenCalled()
})
it('keeps failed saves editable and displays the error', async () => {
  useRemoteConnectionsStore.setState({ save: vi.fn().mockRejectedValue(new Error('Disk full')) })
  await act(async () => root.render(<RemoteSettings />))
  await act(async () => button('Edit').click())
  await act(async () => button('Save connection').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Disk full')
  expect(button('Save connection').disabled).toBe(false)
})
it('keeps all form rows visible when settings search matches SSH', async () => {
  await act(async () => root.render(<SettingsSearchContext.Provider value={{ query: 'ssh', sectionMatched: false }}><RemoteSettings /></SettingsSearchContext.Provider>))
  await act(async () => button('Edit').click())
  expect(host.textContent).toContain('Project folder')
  expect(host.textContent).toContain('Key passphrase')
  expect(host.querySelectorAll('form [data-srow]').length).toBeGreaterThan(4)
})

it('keeps runtime removal in settings with inline confirmation', async () => {
  Object.assign(window.electronAPI, { runtimeDelete: vi.fn().mockResolvedValue({ ok: true }) })
  await act(async () => root.render(<RemoteSettings />))
  await act(async () => button('Check connection').click())
  await act(async () => button('Edit').click())
  await act(async () => button('Uninstall runtime…').click())
  expect(window.electronAPI.runtimeDelete).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => button('Confirm uninstall').click())
  expect(window.electronAPI.runtimeDelete).toHaveBeenCalledWith(connection)
  expect(button('Install runtime')).toBeDefined()
})
