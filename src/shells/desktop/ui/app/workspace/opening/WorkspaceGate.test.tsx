import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { ConnectionState } from '@client/connections'
import { createTrustStore, openTrusted, trustStore, type TrustApi, type WorkspaceList } from '@client/workspaces'
import { installClientApp, type ClientApp } from '../../app'
import { WorkspaceGate } from './WorkspaceGate'

// The workspace's document: synced (or not yet) as each test sets it.
const doc = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const store = {
    synced: true,
    isSynced: () => store.synced,
    getSnapshot: () => ({ panels: {} }),
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
    set(synced: boolean) {
      store.synced = synced
      for (const l of [...listeners]) l()
    },
  }
  return store
})
vi.mock('@client/document', () => ({
  documentStoreFor: () => doc,
  documentStoresVersion: () => 0,
  subscribeDocumentStores: () => () => {},
}))

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
    runtime: { runtime: { update: vi.fn(), info: vi.fn() } },
    set(next: ConnectionState) {
      connection.state = next
      for (const l of [...listeners]) l()
    },
  }
  return connection
}

const workspaces = {
  get: () => ({ kind: 'local', id: 'ws', name: 'ws', root: '/p/ws' }),
  getSnapshot: () => ({ entries: [], open: [] }),
  open: async () => {},
  disconnect: vi.fn(),
  close: vi.fn(async () => {}),
} as unknown as WorkspaceList

function mount(connection: ReturnType<typeof fakeConnection>) {
  const connections = { get: () => connection, subscribe: () => () => {} } as unknown as ClientApp['connections']
  installClientApp({ workspaces, connections, version: '2.0.5' })
  act(() => root.render(<WorkspaceGate workspaceId="ws"><button>panel</button></WorkspaceGate>))
  return connections
}

const cover = () => host.querySelector('[data-connection-blocker]')
const opening = () => host.querySelector('[data-workspace-opening]')

beforeEach(() => {
  doc.synced = true
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
  vi.restoreAllMocks()
})

describe('WorkspaceGate', () => {
  it('shows a ready workspace at once', async () => {
    mount(fakeConnection({ kind: 'connected' }))
    await act(async () => {})
    expect(opening()).toBeNull()
    expect(host.textContent).toContain('panel')
  })

  it('shows neither the windows nor a card until the document is in, then the windows', async () => {
    doc.synced = false
    const connection = fakeConnection({ kind: 'connecting' } as ConnectionState)
    mount(connection)
    expect(opening()).not.toBeNull()
    expect(cover()).toBeNull()
    // Connected, the document not in yet: still no (empty) windows.
    act(() => connection.set({ kind: 'connected' }))
    expect(host.textContent).not.toContain('panel')
    await act(async () => doc.set(true))
    expect(opening()).toBeNull()
    expect(host.textContent).toContain('panel')
  })

  it('shows the status card after a grace and keeps it up long enough to read', async () => {
    doc.synced = false
    const connection = fakeConnection({ kind: 'connecting' } as ConnectionState)
    mount(connection)
    expect(cover()).toBeNull()
    act(() => { vi.advanceTimersByTime(400) })
    expect(cover()?.textContent).toContain('Starting the workspace runtime.')
    await act(async () => { connection.set({ kind: 'connected' }); doc.set(true) })
    expect(opening()).not.toBeNull()
    act(() => { vi.advanceTimersByTime(300) })
    expect(opening()).toBeNull()
    expect(host.textContent).toContain('panel')
  })

  it('a refused connection says so at once', () => {
    doc.synced = false
    mount(fakeConnection({ kind: 'refused', message: 'Runtime refused the connection' }))
    expect(cover()?.textContent).toContain('Connection refused')
  })

  it('asks about trust in the workspace\'s place and shows the workspace once answered', async () => {
    const store = createTrustStore(() => ({
      getTrust: async () => ({ trusted: false, decidedAt: null }),
      setTrust: async () => ({ trusted: true, decidedAt: null }),
    }) as unknown as TrustApi)
    vi.spyOn(trustStore, 'current').mockImplementation(() => store.current())
    vi.spyOn(trustStore, 'subscribe').mockImplementation((l) => store.subscribe(l))
    vi.spyOn(trustStore, 'answer').mockImplementation((t) => store.answer(t))
    const connection = fakeConnection({ kind: 'connected' })
    const connections = mount(connection)
    let opened!: { trusted: Promise<boolean> }
    await act(async () => { opened = await openTrusted({ workspaces, connections, store }, 'ws') })
    expect(host.textContent).toContain('Do you trust this workspace?')
    expect(host.textContent).not.toContain('panel')
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Trust and open')!.click() })
    await expect(opened.trusted).resolves.toBe(true)
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(host.textContent).toContain('panel')
  })
})
