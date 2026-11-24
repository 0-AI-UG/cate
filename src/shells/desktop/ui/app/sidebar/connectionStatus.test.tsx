import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { ConnectionState, WorkspaceConnection } from '@client/connections'
import { selectWorkspace } from '../navigation'
import { WorkspaceToggle, connectionDotClass } from './connectionStatus'

vi.mock('../navigation', () => ({ selectWorkspace: vi.fn(async () => {}), openLocalFolder: vi.fn(async () => {}) }))

let host: HTMLDivElement
let root: Root

function fakeConnection(state: ConnectionState) {
  return {
    workspaceId: 'ws-1',
    startsRuntime: false,
    state,
    getState: () => state,
    subscribe: () => () => {},
    retryNow: vi.fn(),
  }
}

const render = (connection: ReturnType<typeof fakeConnection> | undefined) => {
  act(() => root.render(
    <WorkspaceToggle connection={connection as unknown as WorkspaceConnection} />,
  ))
  return host.querySelector('button')
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('WorkspaceToggle', () => {
  it('shows nothing while connected (the folder icon expands the card)', () => {
    expect(render(fakeConnection({ kind: 'connected' }))).toBeNull()
  })

  it('while not connected, is a status dot that opens the workspace', () => {
    const toggle = render(fakeConnection({ kind: 'offline', lastSeen: null, retrying: false, error: 'ECONNREFUSED' }))!
    expect(toggle.getAttribute('aria-label')).toBe('Not reachable: Its machine may be off or offline.')
    expect(toggle.title).toBe(toggle.getAttribute('aria-label'))
    expect(toggle.dataset.connectionStatus).toBe('offline')
    act(() => toggle.click())
    expect(selectWorkspace).toHaveBeenCalledWith('ws-1')
  })
})

describe('connectionDotClass', () => {
  it('pulses while connecting, not while an offline connection waits to retry', () => {
    expect(connectionDotClass({ kind: 'connecting' })).toContain('animate-pulse')
    expect(connectionDotClass({ kind: 'offline', lastSeen: null, retrying: true })).toBe('bg-amber-400')
    expect(connectionDotClass({ kind: 'offline', lastSeen: null, retrying: false })).toBe('bg-red-500')
  })
})
