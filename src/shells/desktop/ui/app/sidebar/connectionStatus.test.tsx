import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { ConnectionState, WorkspaceConnection } from '@client/connections'
import { selectWorkspace } from '../navigation'
import { WorkspaceToggle } from './connectionStatus'

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

const render = (connection: ReturnType<typeof fakeConnection> | undefined, onToggle = vi.fn()) => {
  act(() => root.render(
    <WorkspaceToggle connection={connection as unknown as WorkspaceConnection} canExpand expanded={false} onToggle={onToggle} />,
  ))
  return host.querySelector('button') as HTMLButtonElement
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
  it('is a plain expand toggle while connected', () => {
    const onToggle = vi.fn()
    const toggle = render(fakeConnection({ kind: 'connected' }), onToggle)
    expect(toggle.getAttribute('aria-label')).toBe('Expand workspace')
    act(() => toggle.click())
    expect(onToggle).toHaveBeenCalled()
  })

  it('while not connected, is a status dot that opens the workspace', () => {
    const onToggle = vi.fn()
    const toggle = render(fakeConnection({ kind: 'offline', lastSeen: null, retrying: false, error: 'ECONNREFUSED' }), onToggle)
    expect(toggle.getAttribute('aria-label')).toBe('Not reachable: The workspace did not answer. Its machine may be off or offline. Cate keeps trying.')
    expect(toggle.title).toBe(toggle.getAttribute('aria-label'))
    expect(toggle.dataset.connectionStatus).toBe('offline')
    act(() => toggle.click())
    expect(selectWorkspace).toHaveBeenCalledWith('ws-1')
    expect(onToggle).not.toHaveBeenCalled()
  })
})
