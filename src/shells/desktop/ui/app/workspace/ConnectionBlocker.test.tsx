import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { ConnectionState } from '@client/connections'
import type { WorkspaceList } from '@client/workspaces'
import { installClientApp, type ClientApp } from '../app'
import { ConnectionBlocker } from './ConnectionBlocker'

let host: HTMLDivElement
let root: Root

function fakeConnection(state: ConnectionState) {
  const listeners = new Set<() => void>()
  const connection = {
    workspaceId: 'ws',
    startsRuntime: true,
    state,
    getState: () => connection.state,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
    retryNow: vi.fn(),
    runtime: { runtime: { update: vi.fn(async () => { throw new Error('in use') }), info: vi.fn() } },
    set(next: ConnectionState) {
      connection.state = next
      for (const l of [...listeners]) l()
    },
  }
  return connection
}

const removeRecent = vi.fn(async () => {})

function mount(connection: ReturnType<typeof fakeConnection>) {
  installClientApp({
    workspaces: { get: () => ({ name: 'ws' }), removeRecent } as unknown as WorkspaceList,
    connections: { get: () => connection, subscribe: () => () => {} } as unknown as ClientApp['connections'],
    version: '2.0.5',
  })
  act(() => root.render(<ConnectionBlocker workspaceId="ws"><button>panel</button></ConnectionBlocker>))
}

const cover = () => host.querySelector('[data-connection-blocker]')
const content = () => host.querySelector('button')?.parentElement as HTMLElement

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  installClientApp(null)
  vi.useRealTimers()
})

describe('ConnectionBlocker', () => {
  it('leaves a connected workspace alone', () => {
    mount(fakeConnection({ kind: 'connected' }))
    expect(cover()).toBeNull()
    expect(content().hasAttribute('inert')).toBe(false)
  })

  it('covers an incompatible workspace at once with the way to resolve it, and makes it inert', async () => {
    mount(fakeConnection({ kind: 'incompatible', runtimeVersion: '1.9.0' }))
    await act(async () => { await Promise.resolve() })
    expect(cover()?.textContent).toContain('Workspace runtime needs an update')
    expect(cover()?.textContent).toContain('Update to')
    expect(content().hasAttribute('inert')).toBe(true)
  })

  it('a stopped runtime covers at once and offers to start again', () => {
    const connection = fakeConnection({ kind: 'stopped' })
    mount(connection)
    expect(cover()?.textContent).toContain('Runtime stopped')
    act(() => (cover()!.querySelector('button') as HTMLButtonElement).click())
    expect(connection.retryNow).toHaveBeenCalled()
  })

  it('a folder nested in an open workspace offers that workspace, or trying again', () => {
    const connection = fakeConnection({ kind: 'refused', message: '/p/app is inside the workspace /p, which is already running.', nestedIn: '/p' })
    mount(connection)
    expect(cover()?.textContent).toContain('/p/app is inside the workspace /p')
    const labels = [...cover()!.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).toEqual(['Open p', 'Try again', 'Remove from list'])
    act(() => (cover()!.querySelectorAll('button')[1] as HTMLButtonElement).click())
    expect(connection.retryNow).toHaveBeenCalled()
  })

  it('a folder that is gone offers to remove it from the list', () => {
    mount(fakeConnection({ kind: 'offline', lastSeen: null, retrying: true, error: "ENOENT: no such file or directory, realpath '/p/app'" }))
    act(() => { vi.advanceTimersByTime(400) })
    expect(cover()?.textContent).toContain('Folder not found')
    act(() => (cover()!.querySelector('button') as HTMLButtonElement).click())
    expect(removeRecent).toHaveBeenCalledWith('ws')
  })

  it('covers a lost connection only after a grace, and uncovers when it is back', () => {
    const connection = fakeConnection({ kind: 'connected' })
    mount(connection)
    act(() => connection.set({ kind: 'offline', lastSeen: null, retrying: false, error: 'connect ECONNREFUSED' }))
    expect(cover()).toBeNull()
    act(() => { vi.advanceTimersByTime(400) })
    expect(cover()?.textContent).toContain('The workspace runtime did not start.')
    expect(cover()?.textContent).not.toContain('ECONNREFUSED')
    act(() => (cover()?.querySelector('button') as HTMLButtonElement).click())
    expect(connection.retryNow).toHaveBeenCalled()
    act(() => connection.set({ kind: 'connected' }))
    expect(cover()).toBeNull()
    expect(content().hasAttribute('inert')).toBe(false)
  })
})
