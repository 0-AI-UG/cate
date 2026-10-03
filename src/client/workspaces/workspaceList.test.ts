import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { tryRuntimeFor } from '@kernel/rpc/client'
import { KNOWN_RUNTIMES_DOCUMENT } from '@runtime/pairing/client'
import { WorkspaceConnections, createClientIdentity, type ShellTransports } from '@client/connections'
import { WORKSPACES_DOCUMENT, WorkspaceList } from './workspaceList'

const never = () => new Promise<never>(() => {})
const transports: ShellTransports = { dialLocal: never, dialNetwork: never, dialLoopbackTcp: never }
const identity = createClientIdentity({ device: { name: 'd', keyFingerprint: 'FP' }, features: [] })
const key = new Uint8Array(32).fill(7)

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

async function setup(store = createMemoryDeviceStore()) {
  let t = 1000
  const connections = new WorkspaceConnections({ identity, transports, version: '1.0.0' })
  const list = new WorkspaceList({ store, connections, now: () => ++t })
  cleanup.push(() => list.dispose(), () => connections.dispose())
  await list.load()
  return { store, connections, list }
}

describe('WorkspaceList', () => {
  it('keeps recents, paired workspaces and the sidebar order across loads', async () => {
    const { store, list } = await setup()
    await list.addLocal('/home/me/alpha')
    await list.addLocal('/home/me/beta')
    const paired = await list.addPaired({
      runtimeId: 'RT1',
      name: 'Server',
      endpoints: [{ kind: 'lan', address: '10.0.0.2', port: 4000 }],
      publicKey: key,
    })
    expect(paired.id).toBe('paired:RT1')
    // Newest first before any explicit order.
    expect(list.getSnapshot().entries.map((e) => e.id)).toEqual(['paired:RT1', 'local:/home/me/beta', 'local:/home/me/alpha'])

    await list.reorder(['local:/home/me/alpha', 'paired:RT1'])
    await list.rename('local:/home/me/alpha', 'Alpha')

    const again = await setup(store)
    const entries = again.list.getSnapshot().entries
    expect(entries.map((e) => e.id)).toEqual(['local:/home/me/alpha', 'paired:RT1', 'local:/home/me/beta'])
    expect(entries[0]).toMatchObject({ kind: 'local', root: '/home/me/alpha', name: 'Alpha' })
    expect(entries[1]).toMatchObject({ kind: 'paired', runtimeId: 'RT1', endpoints: [{ kind: 'lan', address: '10.0.0.2', port: 4000 }] })
    expect(await again.list.known.get('RT1')).toEqual(key)
  })

  it('opens a workspace as a connection and closes it again', async () => {
    const { list, connections } = await setup()
    const entry = await list.addLocal('/w')
    const connection = await list.open(entry.id)
    expect(connection.target).toEqual({ kind: 'local', root: '/w' })
    expect(connections.get(entry.id)).toBe(connection)
    expect(tryRuntimeFor(entry.id)).toBe(connection.runtime)
    expect(list.getSnapshot().open).toEqual([entry.id])
    list.close(entry.id)
    expect(list.getSnapshot().open).toEqual([])
    expect(connection.state.kind).toBe('closed')
  })

  it('forgets a paired workspace: closes it and deletes its pinned key', async () => {
    const { store, list } = await setup()
    const entry = await list.addPaired({ runtimeId: 'RT2', name: 'Box', endpoints: [{ kind: 'connect' }], publicKey: key })
    const connection = await list.open(entry.id)
    expect(connection.target).toEqual({ kind: 'network', runtimeId: 'RT2', endpoints: [{ kind: 'connect' }] })
    await list.reorder([entry.id])
    await list.forget(entry.id)
    expect(connection.state.kind).toBe('closed')
    expect(list.getSnapshot().entries).toEqual([])
    expect(await list.known.get('RT2')).toBeUndefined()
    expect(await store.get(KNOWN_RUNTIMES_DOCUMENT)).toEqual({ runtimes: {} })
    expect(await store.get(WORKSPACES_DOCUMENT)).toEqual({ local: [], paired: [], order: [] })
  })

  it('follows outside edits and ignores malformed entries', async () => {
    const { store, list } = await setup()
    let changes = 0
    list.subscribe(() => changes++)
    store.change(WORKSPACES_DOCUMENT, {
      local: [{ root: '/x', lastOpenedAt: 5 }, { name: 'no root' }, 'junk'],
      paired: [{ runtimeId: 'R', endpoints: [{ kind: 'lan', address: 'h' }, { kind: 'connect' }] }],
      order: ['paired:R', 7],
    })
    expect(changes).toBe(1)
    expect(list.getSnapshot().entries).toEqual([
      { kind: 'paired', id: 'paired:R', runtimeId: 'R', name: 'R', endpoints: [{ kind: 'connect' }], pairedAt: 0, lastOpenedAt: null },
      { kind: 'local', id: 'local:/x', root: '/x', name: 'x', lastOpenedAt: 5 },
    ])
  })
})
