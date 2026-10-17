// Opening a workspace: the phase rule, and `openTrusted`, which keeps the
// workspace opening until its trust is settled.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { workspacePhase, workspacePhaseOf, openTrusted } from './opening'
import { createTrustStore, type TrustApi, type TrustStore } from './trust'

// The workspace's document is in: only trust keeps it opening.
vi.mock('@client/document', () => ({
  documentStoreFor: () => ({ isSynced: () => true }),
  subscribeDocumentStores: () => () => {},
}))

describe('workspacePhase', () => {
  const connecting = { kind: 'connecting' } as const
  const connected = { kind: 'connected' } as const
  const offline = { kind: 'offline', lastSeen: null, retrying: true } as const

  it('is closed without a connection', () => {
    expect(workspacePhase({ state: null, synced: false, trusting: false })).toBe('closed')
    expect(workspacePhase({ state: { kind: 'closed' }, synced: true, trusting: false })).toBe('closed')
  })

  it('is opening until the first document and the trust answer are in', () => {
    expect(workspacePhase({ state: connecting, synced: false, trusting: true })).toBe('opening')
    // Connected, the document not here yet: no empty layout in between.
    expect(workspacePhase({ state: connected, synced: false, trusting: false })).toBe('opening')
    expect(workspacePhase({ state: connected, synced: true, trusting: true })).toBe('opening')
    expect(workspacePhase({ state: connected, synced: true, trusting: false })).toBe('ready')
  })

  it('stays ready over a dropped connection once it had its document', () => {
    expect(workspacePhase({ state: offline, synced: true, trusting: false })).toBe('ready')
    expect(workspacePhase({ state: { kind: 'stopped' }, synced: true, trusting: false })).toBe('ready')
  })

  it('is unavailable when the connection failed before the first document', () => {
    expect(workspacePhase({ state: offline, synced: false, trusting: false })).toBe('unavailable')
    expect(workspacePhase({ state: { kind: 'incompatible', runtimeVersion: '1' }, synced: false, trusting: true })).toBe('unavailable')
  })
})

let trusted: Set<string>
let store: TrustStore
const connections = { get: () => ({ state: { kind: 'connected' }, subscribe: () => () => {} }) } as never

beforeEach(() => {
  trusted = new Set()
  store = createTrustStore((id) => ({
    getTrust: async () => ({ trusted: trusted.has(id), decidedAt: null }),
    setTrust: async ({ trusted: value }: { trusted: boolean }) => {
      if (value) trusted.add(id)
      return { trusted: value, decidedAt: null }
    },
  }) as TrustApi)
})

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('openTrusted', () => {
  const opens = vi.fn()
  const disconnect = vi.fn()
  const close = vi.fn()
  const deps = (open: string[]) => ({
    workspaces: {
      get: (id: string) => ({ id, kind: 'paired' as const, runtimeId: id, name: id, endpoints: [] }),
      getSnapshot: () => ({ open }),
      open: async (id: string) => { opens(id); open.push(id) },
      disconnect,
      close,
    },
    connections,
    store,
  }) as unknown as Parameters<typeof openTrusted>[0]

  it('opens, asks once its runtime answers, and only disconnects a declined workspace', async () => {
    disconnect.mockClear()
    close.mockClear()
    const opened = await openTrusted(deps([]), 'ws')
    await tick()
    expect(store.current()).toMatchObject({ workspaceId: 'ws' })
    await store.answer(false)
    await expect(opened.trusted).resolves.toBe(false)
    expect(disconnect).toHaveBeenCalledWith('ws')
    // Closing would drop the entry and, for a paired one, its pinned key.
    expect(close).not.toHaveBeenCalled()
  })

  it('is opening from the call until the trust answer, then ready', async () => {
    const opened = await openTrusted(deps([]), 'ws')
    expect(workspacePhaseOf(connections, 'ws')).toBe('opening')
    await tick()
    expect(store.current()).toMatchObject({ workspaceId: 'ws' })
    await store.answer(true)
    await opened.trusted
    expect(workspacePhaseOf(connections, 'ws')).toBe('ready')
  })

  it('is ready at once for a trusted workspace once it answers', async () => {
    trusted.add('ws')
    const opening = openTrusted(deps([]), 'ws')
    expect(workspacePhaseOf(connections, 'ws')).toBe('opening')
    await (await opening).trusted
    expect(workspacePhaseOf(connections, 'ws')).toBe('ready')
  })

  it('asks nothing for a workspace already open', async () => {
    opens.mockClear()
    await expect((await openTrusted(deps(['ws']), 'ws')).trusted).resolves.toBe(true)
    expect(opens).not.toHaveBeenCalled()
  })
})
