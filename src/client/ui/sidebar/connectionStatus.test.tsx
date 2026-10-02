import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { ConnectionState, WorkspaceConnection } from '@client/connections'
import { WorkspaceToggle } from './connectionStatus'

let host: HTMLDivElement
let root: Root

function fakeConnection(state: ConnectionState) {
  return {
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
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('WorkspaceToggle', () => {
  it('is a plain expand toggle while connected', () => {
    const onToggle = vi.fn()
    const toggle = render(fakeConnection({ kind: 'connected' }), onToggle)
    expect(toggle.getAttribute('aria-label')).toBe('Expand workspace')
    act(() => toggle.click())
    expect(onToggle).toHaveBeenCalled()
  })

  it('shows the status on hover with the action that fixes it', () => {
    const connection = fakeConnection({ kind: 'offline', lastSeen: null, retrying: false, error: 'ECONNREFUSED' })
    const toggle = render(connection)
    expect(toggle.getAttribute('aria-label')).toBe('Not reachable: ECONNREFUSED')
    act(() => {
      toggle.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      vi.advanceTimersByTime(300)
    })
    const popover = document.body.querySelector('[role="status"]') as HTMLElement
    expect(popover.textContent).toContain('Offline')
    expect(popover.textContent).toContain('Not reachable: ECONNREFUSED')
    const retry = [...popover.querySelectorAll('button')].find((b) => b.textContent === 'Retry now') as HTMLButtonElement
    act(() => retry.click())
    expect(connection.retryNow).toHaveBeenCalled()
    expect(document.body.querySelector('[role="status"]')).toBeNull()
  })
})
