import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, StrictMode } from 'react'
import { createRuntimeUpdates, type ConnectionState, type RuntimeUpdates } from '@client/connections'
import type { WorkspaceList } from '@client/workspaces'
import { installClientApp, type ClientApp } from '../app'
import { ConnectionBlocker } from './ConnectionBlocker'

let host: HTMLDivElement
let root: Root
let idle = false
let progress: unknown = null
let updates: RuntimeUpdates | null = null

function fakeConnection(state: ConnectionState) {
  const listeners = new Set<() => void>()
  const connection = {
    clientId: 'self',
    rpc: { remote: { epoch: 1, build: '2.0.4+new' } },
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
        info: vi.fn(async () => ({ pid: 727, clients: [{ clientId: 'self' }] })),
        updateProgress: vi.fn(async () => progress),
      },
    },
    set(next: ConnectionState) {
      if (next.kind === 'connected' || next.kind === 'incompatible') connection.rpc.remote.epoch++
      connection.state = next
      for (const l of [...listeners]) l()
    },
  }
  return connection
}

/** The workspace inside its blocker, next to a sidebar the blocker must not cover. */
const render = (connection: ReturnType<typeof fakeConnection>, strict = false) => {
  const connections = { get: () => connection, getSnapshot: () => [connection], subscribe: () => () => {} } as unknown as ClientApp['connections']
  // The core's flow, as the app runs it: it tries the idle update at once.
  updates = createRuntimeUpdates({ connections, version: '2.0.4', build: '2.0.4+new' })
  installClientApp({
    workspaces: { get: () => ({ name: 'cate' }) } as unknown as WorkspaceList,
    connections,
    runtimeUpdates: updates,
    version: '2.0.4',
  })
  const tree = (
    <>
      <nav data-sidebar><button>other workspace</button></nav>
      <ConnectionBlocker workspaceId={connection.workspaceId}><button>panel</button></ConnectionBlocker>
    </>
  )
  return act(async () => root.render(strict ? <StrictMode>{tree}</StrictMode> : tree))
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
  updates?.dispose()
  updates = null
})

describe('RuntimeMismatchCard', () => {
  it('covers a compatible older workspace until its shared runtime update is confirmed', async () => {
    const connection = fakeConnection({ kind: 'connected', runtimeVersion: '2.0.3' })
    await render(connection)
    expect(connection.runtime.runtime.update).toHaveBeenCalledWith({ version: '2.0.4', build: '2.0.4+new', ifIdle: true })
    expect(card()?.textContent).toContain('Stops terminals and agents for everyone.')
    expect(card()?.textContent).not.toContain("can't talk to")
    await act(async () => button('Update and Stop Work…').click())
    expect(connection.runtime.runtime.update).toHaveBeenLastCalledWith({ version: '2.0.4', build: '2.0.4+new' })
    expect(card()?.textContent).toContain('Reopening')
    await act(async () => connection.set({ kind: 'connected', runtimeVersion: '2.0.4' }))
    expect(card()).toBeNull()
  })

  it('keeps a compatible newer workspace usable', async () => {
    const connection = fakeConnection({ kind: 'connected', runtimeVersion: '2.0.5' })
    await render(connection)
    expect(connection.runtime.runtime.update).not.toHaveBeenCalled()
    expect(card()).toBeNull()
  })

  it('keeps a compatible older shared workspace usable after an idle update is refused', async () => {
    const connection = fakeConnection({ kind: 'connected', runtimeVersion: '2.0.3' })
    connection.runtime.runtime.info.mockResolvedValue({ pid: 727, clients: [{ clientId: 'self' }, { clientId: 'other' }] })
    await render(connection)
    expect(connection.runtime.runtime.update).toHaveBeenCalledWith({ version: '2.0.4', build: '2.0.4+new', ifIdle: true })
    expect(card()).toBeNull()
    expect(button('panel').closest('[inert]')).toBeNull()
  })

  it('updates a compatible older unshared workspace immediately when idle', async () => {
    idle = true
    const connection = fakeConnection({ kind: 'connected', runtimeVersion: '2.0.3' })
    await render(connection)
    expect(card()?.textContent).toContain('Reopening')
    expect(button('Update and Stop Work')).toBeUndefined()
    await act(async () => connection.set({ kind: 'connected', runtimeVersion: '2.0.4' }))
    expect(card()).toBeNull()
  })

  it('asks inside the workspace only: no dialog over the app, the sidebar stays usable', async () => {
    await render(fakeConnection({ kind: 'incompatible', runtimeVersion: '1.9.0' }))
    expect(card()?.textContent).toContain('Workspace update ready')
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(host.querySelector('[data-sidebar]')!.closest('[inert]')).toBeNull()
  })

  it('updates a runtime of another version to this app\'s build', async () => {
    const connection = fakeConnection({ kind: 'incompatible', runtimeVersion: '1.9.0' })
    await render(connection)
    expect(connection.runtime.runtime.update).toHaveBeenCalledWith({ version: '2.0.4', build: '2.0.4+new', ifIdle: true })
    expect(card()?.textContent).toContain('1.9.0')
    await act(async () => button('Update and Stop Work…').click())
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
      await act(async () => button('Update and Stop Work…').click())
      expect(card()?.textContent).toContain('Updating the workspace')

      progress = { phase: 'download', received: 5_000_000, total: 20_000_000 }
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(card()?.textContent).toContain('Downloading workspace update')
      expect(card()?.textContent).toContain('5.0 of 20.0 MB')
      expect(card()?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('20')

      progress = { phase: 'install' }
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(card()?.textContent).toContain('Installing workspace update')
      expect(card()?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('85')

      await act(async () => finish())
      await act(async () => connection.set({ kind: 'offline', lastSeen: 1, retrying: true }))
      expect(card()?.textContent).toContain('Reopening the workspace')
      await act(async () => connection.set({ kind: 'connecting' }))
      expect(card()?.textContent).toContain('Reopening the workspace')

      await act(async () => connection.set({ kind: 'connected' }))
      expect(card()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks once the idle update is refused under StrictMode', async () => {
    await render(fakeConnection({ kind: 'incompatible', runtimeVersion: '1.9.0' }), true)
    expect(button('Update and Stop Work…')).toBeTruthy()
  })

  it('says so when the runtime does not restart', async () => {
    vi.useFakeTimers()
    try {
      await render(fakeConnection({ kind: 'incompatible', runtimeVersion: '1.9.0' }))
      await act(async () => button('Update and Stop Work…').click())
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(card()?.textContent).toContain('The runtime did not restart. Stop it (process 727)')
      expect(button('Update and Stop Work…').disabled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers an update for another version', async () => {
    await render(fakeConnection({ kind: 'incompatible', runtimeVersion: '1.7.0' }))
    expect(card()?.textContent).toContain('Workspace update ready')
    expect(button('Update and Stop Work…')).toBeTruthy()
  })

  it('updates a runtime nothing else uses without asking', async () => {
    idle = true
    const connection = fakeConnection({ kind: 'incompatible', runtimeVersion: '2.0.3' })
    await render(connection)
    expect(connection.runtime.runtime.update).toHaveBeenCalledWith({ version: '2.0.4', build: '2.0.4+new', ifIdle: true })
    // The fake update returns at once: it is restarting.
    expect(card()?.textContent).toContain('Reopening the workspace')
    expect(button('Update and Stop Work')).toBeUndefined()
  })

  it('never moves a newer runtime back to this app', async () => {
    idle = true
    const connection = fakeConnection({ kind: 'incompatible', runtimeVersion: '2.1.0' })
    await render(connection)
    expect(connection.runtime.runtime.update).not.toHaveBeenCalled()
    expect(card()?.textContent).toContain('Update Cate')
    expect(button('Update and Stop Work')).toBeUndefined()
  })
})
