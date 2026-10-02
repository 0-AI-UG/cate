import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { ConnectionState, WorkspaceConnection } from '@client/connections'
import type { WorkspaceList } from '@client/workspaces'
import { installClientApp, type ClientApp } from '../app'
import { RuntimeMismatchDialog, showRuntimeMismatch } from './RuntimeMismatchDialog'

let host: HTMLDivElement
let root: Root
let idle = false

function fakeConnection(state: ConnectionState) {
  const listeners = new Set<() => void>()
  const connection = {
    workspaceId: 'local:/p/cate',
    state,
    getState: () => connection.state,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
    runtime: {
      runtime: {
        // In use by default: the idle update is refused and the dialog asks.
        update: vi.fn(async (params: { ifIdle?: boolean }) => {
          if (params.ifIdle && !idle) throw Object.assign(new Error('the runtime has other clients or running work'), { code: 'dirty' })
        }),
        info: vi.fn(async () => ({ pid: 727 })),
      },
    },
    set(next: ConnectionState) {
      connection.state = next
      for (const l of [...listeners]) l()
    },
  }
  return connection
}

function install(connection: ReturnType<typeof fakeConnection>) {
  installClientApp({
    workspaces: { get: () => ({ name: 'cate' }) } as unknown as WorkspaceList,
    connections: {
      getSnapshot: () => [connection],
      subscribe: () => () => {},
    } as unknown as ClientApp['connections'],
    version: '2.0.4',
  })
}

const dialog = () => document.body.querySelector('[role="dialog"]')
const render = () => act(async () => root.render(<RuntimeMismatchDialog />))
const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement

beforeEach(() => {
  idle = false
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  installClientApp(null)
})

describe('RuntimeMismatchDialog', () => {
  it('shows both builds of a stale runtime and restarts it', async () => {
    const connection = fakeConnection({ kind: 'incompatible', runtimeVersion: '2.0.4', build: { runtime: null, app: '2.0.4+new' } })
    install(connection)
    await render()
    expect(connection.runtime.runtime.update).toHaveBeenCalledWith({ version: '2.0.4', build: '2.0.4+new', ifIdle: true })
    expect(dialog()?.textContent).toContain('Workspace runtime is out of date')
    expect(dialog()?.textContent).toContain('2.0.4+new')
    expect(dialog()?.textContent).toContain('2.0.4 (no build)')
    await act(async () => button('Restart runtime').click())
    expect(connection.runtime.runtime.update).toHaveBeenLastCalledWith({ version: '2.0.4', build: '2.0.4+new' })
    act(() => connection.set({ kind: 'connecting' }))
    expect(dialog()).toBeNull()
  })

  it('says so when the runtime does not restart', async () => {
    vi.useFakeTimers()
    try {
      const connection = fakeConnection({ kind: 'incompatible', runtimeVersion: '2.0.4', build: { runtime: '2.0.4+old', app: '2.0.4+new' } })
      install(connection)
      await render()
      await act(async () => button('Restart runtime').click())
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(dialog()?.textContent).toContain('The runtime did not restart. Stop it (process 727)')
      expect(button('Restart runtime').disabled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers an update for another version and stays away after "Not now" until reopened', async () => {
    const connection = fakeConnection({ kind: 'incompatible', runtimeVersion: '1.7.0' })
    install(connection)
    await render()
    expect(dialog()?.textContent).toContain('Workspace runtime needs an update')
    expect(button('Update to 2.0.4')).toBeTruthy()
    act(() => button('Not now').click())
    expect(dialog()).toBeNull()
    act(() => showRuntimeMismatch(connection as unknown as WorkspaceConnection))
    expect(dialog()).not.toBeNull()
  })

  it('updates a runtime nothing else uses without asking', async () => {
    idle = true
    const connection = fakeConnection({ kind: 'incompatible', runtimeVersion: '2.0.3', build: { runtime: '2.0.3+old', app: '2.0.4+new' } })
    install(connection)
    await render()
    expect(connection.runtime.runtime.update).toHaveBeenCalledWith({ version: '2.0.4', build: '2.0.4+new', ifIdle: true })
    expect(dialog()).toBeNull()
    act(() => connection.set({ kind: 'connecting' }))
    expect(dialog()).toBeNull()
  })

  it('never moves a newer runtime back to this app', async () => {
    idle = true
    const connection = fakeConnection({ kind: 'incompatible', runtimeVersion: '2.1.0', build: { runtime: '2.1.0+x', app: '2.0.4+new' } })
    install(connection)
    await render()
    expect(connection.runtime.runtime.update).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain('Update Cate to use this workspace')
    expect(button('Update to')).toBeUndefined()
  })
})
