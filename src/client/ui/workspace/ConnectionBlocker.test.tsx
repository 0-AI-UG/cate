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
    state,
    getState: () => connection.state,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
    retryNow: vi.fn(),
    set(next: ConnectionState) {
      connection.state = next
      for (const l of [...listeners]) l()
    },
  }
  return connection
}

function mount(connection: ReturnType<typeof fakeConnection>) {
  installClientApp({
    workspaces: {} as WorkspaceList,
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

  it('covers an incompatible workspace at once and makes it inert', () => {
    mount(fakeConnection({ kind: 'incompatible', runtimeVersion: '2.0.5', build: { runtime: null, app: '2.0.5+a' } }))
    expect(cover()?.textContent).toContain('Runtime out of date')
    expect(cover()?.textContent).toContain('Resolve…')
    expect(content().hasAttribute('inert')).toBe(true)
  })

  it('covers a lost connection only after a grace, and uncovers when it is back', () => {
    const connection = fakeConnection({ kind: 'connected' })
    mount(connection)
    act(() => connection.set({ kind: 'offline', lastSeen: null, retrying: false, error: 'ECONNREFUSED' }))
    expect(cover()).toBeNull()
    act(() => { vi.advanceTimersByTime(400) })
    expect(cover()?.textContent).toContain('Not reachable: ECONNREFUSED')
    act(() => (cover()?.querySelector('button') as HTMLButtonElement).click())
    expect(connection.retryNow).toHaveBeenCalled()
    act(() => connection.set({ kind: 'connected' }))
    expect(cover()).toBeNull()
    expect(content().hasAttribute('inert')).toBe(false)
  })
})
