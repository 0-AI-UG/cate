import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { ConnectionState } from '@client/connections'
import type { WorkspaceList } from '@client/workspaces'
import { installClientApp, type ClientApp } from '../app'
import { ConnectionBlocker } from './ConnectionBlocker'

let host: HTMLDivElement
let root: Root
let idle = false
let progress: unknown = null

function fakeConnection(state: ConnectionState) {
  const listeners = new Set<() => void>()
  const connection = {
    workspaceId: 'local:/p/cate',
    state,
    getState: () => connection.state,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
    retryNow: vi.fn(),
    runtime: {
      runtime: {
        // In use by default: the idle update is refused and the card asks.
        update: vi.fn(async (params: { ifIdle?: boolean }) => {
          if (params.ifIdle && !idle) throw Object.assign(new Error('the runtime has other clients or running work'), { code: 'dirty' })
        }),
        info: vi.fn(async () => ({ pid: 727 })),
        updateProgress: vi.fn(async () => progress),
      },
    },
    set(next: ConnectionState) {
      connection.state = next
      for (const l of [...listeners]) l()
    },
  }
  return connection
}

/** The workspace inside its blocker, next to a sidebar the blocker must not cover. */
const render = (connection: ReturnType<typeof fakeConnection>) => {
  installClientApp({
    workspaces: { get: () => ({ name: 'cate' }) } as unknown as WorkspaceList,
    connections: { get: () => connection, subscribe: () => () => {} } as unknown as ClientApp['connections'],
    version: '2.0.4',
  })
  return act(async () => root.render(
    <>
      <nav data-sidebar><button>other workspace</button></nav>
      <ConnectionBlocker workspaceId={connection.workspaceId}><button>panel</button></ConnectionBlocker>
    </>,
  ))
}

const card = () => host.querySelector('[data-connection-blocker]')
const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement

beforeEach(() => {
  idle = false
  progress = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  installClientApp(null)
})

describe('RuntimeMismatchCard', () => {
  it('asks inside the workspace only: no dialog over the app, the sidebar stays usable', async () => {
    await render(fakeConnection({ kind: 'incompatible', runtimeVersion: '2.0.4', build: { runtime: null, app: '2.0.4+new' } }))
    expect(card()?.textContent).toContain('Workspace runtime is out of date')
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(host.querySelector('[data-sidebar]')!.closest('[inert]')).toBeNull()
  })

  it('shows both builds of a stale runtime and restarts it', async () => {
    const connection = fakeConnection({ kind: 'incompatible', runtimeVersion: '2.0.4', build: { runtime: null, app: '2.0.4+new' } })
    await render(connection)
    expect(connection.runtime.runtime.update).toHaveBeenCalledWith({ version: '2.0.4', build: '2.0.4+new', ifIdle: true })
    expect(card()?.textContent).toContain('2.0.4+new')
    expect(card()?.textContent).toContain('2.0.4 (no build)')
    await act(async () => button('Restart runtime').click())
    expect(connection.runtime.runtime.update).toHaveBeenLastCalledWith({ version: '2.0.4', build: '2.0.4+new' })
    await act(async () => connection.set({ kind: 'connected' }))
    expect(card()).toBeNull()
  })

  it('shows the download, then holds the card through the restart until the runtime is back', async () => {
    vi.useFakeTimers()
    try {
      let finish!: () => void
      const connection = fakeConnection({ kind: 'incompatible', runtimeVersion: '2.0.3' })
      await render(connection)
      connection.runtime.runtime.update.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
      await act(async () => button('Update to 2.0.4').click())
      expect(card()?.textContent).toContain('Updating the workspace runtime')

      progress = { phase: 'download', received: 5_000_000, total: 20_000_000 }
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(card()?.textContent).toContain('Downloading Cate runtime 2.0.4')
      expect(card()?.textContent).toContain('5.0 of 20.0 MB')
      expect(card()?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('20')

      progress = { phase: 'install' }
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(card()?.textContent).toContain('Installing the workspace runtime')
      expect(card()?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('85')

      await act(async () => finish())
      await act(async () => connection.set({ kind: 'offline', lastSeen: 1, retrying: true }))
      expect(card()?.textContent).toContain('Restarting the workspace runtime')
      await act(async () => connection.set({ kind: 'connecting' }))
      expect(card()?.textContent).toContain('Restarting the workspace runtime')

      await act(async () => connection.set({ kind: 'connected' }))
      expect(card()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says so when the runtime does not restart', async () => {
    vi.useFakeTimers()
    try {
      await render(fakeConnection({ kind: 'incompatible', runtimeVersion: '2.0.4', build: { runtime: '2.0.4+old', app: '2.0.4+new' } }))
      await act(async () => button('Restart runtime').click())
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(card()?.textContent).toContain('The runtime did not restart. Stop it (process 727)')
      expect(button('Restart runtime').disabled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers an update for another version', async () => {
    await render(fakeConnection({ kind: 'incompatible', runtimeVersion: '1.7.0' }))
    expect(card()?.textContent).toContain('Workspace runtime needs an update')
    expect(button('Update to 2.0.4')).toBeTruthy()
  })

  it('updates a runtime nothing else uses without asking', async () => {
    idle = true
    const connection = fakeConnection({ kind: 'incompatible', runtimeVersion: '2.0.3', build: { runtime: '2.0.3+old', app: '2.0.4+new' } })
    await render(connection)
    expect(connection.runtime.runtime.update).toHaveBeenCalledWith({ version: '2.0.4', build: '2.0.4+new', ifIdle: true })
    // The fake update returns at once: it is restarting.
    expect(card()?.textContent).toContain('Restarting the workspace runtime')
    expect(button('Update to')).toBeUndefined()
  })

  it('never moves a newer runtime back to this app', async () => {
    idle = true
    const connection = fakeConnection({ kind: 'incompatible', runtimeVersion: '2.1.0', build: { runtime: '2.1.0+x', app: '2.0.4+new' } })
    await render(connection)
    expect(connection.runtime.runtime.update).not.toHaveBeenCalled()
    expect(card()?.textContent).toContain('Update Cate to use this workspace')
    expect(button('Update to')).toBeUndefined()
  })
})
