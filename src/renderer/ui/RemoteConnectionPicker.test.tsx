import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RemoteConnectionPicker } from './RemoteConnectionPicker'
import { useRemoteConnectionsStore } from '../stores/remoteConnectionsStore'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import type { RemoteRuntimeConnection } from '../../shared/runtimeConnection'
import type { WorkspaceState } from '../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
const initial = useRemoteConnectionsStore.getState()
const appInitial = useAppStore.getState()
const connection: RemoteRuntimeConnection = { kind: 'server', runtimeId: 'srv_test', host: 'dev', user: 'me', remotePath: '/project' }
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  useRemoteConnectionsStore.setState({ connections: [connection], loaded: true, load: vi.fn().mockResolvedValue(undefined) })
  useAppStore.setState({ workspaces: [{ id: 'empty', rootPath: '', panels: {} } as WorkspaceState], connectRemoteWorkspace: vi.fn().mockResolvedValue(false), selectWorkspace: vi.fn().mockResolvedValue(undefined) })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useRemoteConnectionsStore.setState(initial, true); useAppStore.setState(appInitial, true) })
function choose(value: string) {
  const select = host.querySelector('select')!
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}
it('uses a native select with saved profiles and no inline list or modal', async () => {
  await act(async () => root.render(<RemoteConnectionPicker workspaceId="empty" />))
  const select = host.querySelector('select')!
  expect(select.getAttribute('aria-label')).toBe('Connect to remote')
  expect(select.value).toBe('')
  expect(select.querySelector('option[value="srv_test"]')?.textContent).toContain('me@dev · SSH · /project')
  expect(host.querySelector('button')).toBeNull()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
it('opens the selected profile in the empty workspace without passing authentication defaults', async () => {
  await act(async () => root.render(<RemoteConnectionPicker workspaceId="empty" />))
  await act(async () => choose('srv_test'))
  expect(useAppStore.getState().connectRemoteWorkspace).toHaveBeenCalledWith('empty', { kind: 'server', host: 'dev', user: 'me', remotePath: '/project' })
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Check its details in Settings')
})
it('focuses an already open connection instead of duplicating the workspace', async () => {
  useAppStore.setState({ workspaces: [{ id: 'existing', connection } as WorkspaceState] })
  await act(async () => root.render(<RemoteConnectionPicker workspaceId="empty" />))
  await act(async () => choose('srv_test'))
  expect(useAppStore.getState().selectWorkspace).toHaveBeenCalledWith('existing')
  expect(useAppStore.getState().connectRemoteWorkspace).not.toHaveBeenCalled()
})
it('points users with no saved connections to Settings', async () => {
  useRemoteConnectionsStore.setState({ connections: [] })
  const settings = vi.spyOn(useUIStore.getState(), 'openSettings').mockImplementation(() => {})
  await act(async () => root.render(<RemoteConnectionPicker workspaceId="empty" />))
  expect(host.textContent).toContain('No saved connections yet')
  await act(async () => choose('__manage'))
  expect(settings).toHaveBeenCalledWith('remote connections')
})

it('disables the select while connecting and permits retry after failure', async () => {
  let finish: (result: boolean) => void = () => {}
  useAppStore.setState({ connectRemoteWorkspace: vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve })) })
  await act(async () => root.render(<RemoteConnectionPicker workspaceId="empty" />))
  act(() => choose('srv_test'))
  expect(host.querySelector('select')!.disabled).toBe(true)
  await act(async () => finish(false))
  expect(host.querySelector('select')!.disabled).toBe(false)
  expect(host.querySelector('select')!.value).toBe('')
})
