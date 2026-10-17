import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { setRuntimeResolver, tryRuntimeFor } from '@kernel/rpc/client'
import { KNOWN_RUNTIMES_DOCUMENT } from '@runtime/pairing/client'
import { WorkspaceConnections, createClientIdentity, type ShellTransports } from '@client/connections'
import { targetOf, workspaceLocation, WORKSPACES_DOCUMENT, WorkspaceList } from './workspaceList'
import { RUNTIME_CAPABILITIES } from '@panels/capabilities'

const never = () => new Promise<never>(() => {})
const transports: ShellTransports = { dialLocal: never, dialNetwork: never, dialLoopbackTcp: never }
const identity = createClientIdentity({ device: { name: 'd', publicKey: 'FP' }, features: [] })
const key = new Uint8Array(32).fill(7)

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

async function setup(store = createMemoryDeviceStore()) {
  let t = 1000
  const connections = new WorkspaceConnections({
      capabilities: RUNTIME_CAPABILITIES, identity, transports, version: '1.0.0' })
  const list = new WorkspaceList({ store, connections, now: () => ++t })
  // As the client core does.
  const stopResolver = setRuntimeResolver((workspaceId) => connections.get(workspaceId)?.runtime ?? null)
  cleanup.push(() => list.dispose(), () => connections.dispose(), stopResolver)
  await list.load()
  return { store, connections, list }
}

describe('WorkspaceList', () => {
  it('keeps workspaces on machines, reached through the machine', async () => {
    const store = createMemoryDeviceStore()
    const { list } = await setup(store)
    const box = { kind: 'ssh' as const, target: { destination: 'u@box', port: 2222 } }
    const entry = await list.addMachine(box, '/srv/app')
    expect(entry).toMatchObject({ kind: 'machine', name: 'app', root: '/srv/app' })
    expect(targetOf(entry)).toEqual({ kind: 'machine', machine: box, root: '/srv/app' })
    expect(workspaceLocation(entry)).toBe('u@box:/srv/app')
    await list.addMachine({ kind: 'wsl', distro: 'Ubuntu' }, '/srv/app')
    expect(list.getSnapshot().entries).toHaveLength(2)

    // A hand-edited entry that names no valid machine is dropped.
    await store.set(WORKSPACES_DOCUMENT, { ...(await store.get(WORKSPACES_DOCUMENT) as object), machine: [
      ...((await store.get(WORKSPACES_DOCUMENT)) as { machine: unknown[] }).machine,
      { machine: { kind: 'ssh', target: { destination: '-oProxyCommand=x' } }, root: '/x' },
    ] })
    const reloaded = (await setup(store)).list
    expect(reloaded.getSnapshot().entries.map((e) => e.id)).toEqual(list.getSnapshot().entries.map((e) => e.id))
  })

  it('keeps the workspaces, their names and the sidebar order across loads', async () => {
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
    // A new one joins last, and opening one does not move it.
    await list.open('local:/home/me/alpha')
    expect(list.getSnapshot().entries.map((e) => e.id)).toEqual(['local:/home/me/alpha', 'local:/home/me/beta', 'paired:RT1'])

    await list.reorder(['paired:RT1', 'local:/home/me/alpha', 'local:/home/me/beta'])
    await list.rename('local:/home/me/alpha', 'Alpha')

    const again = await setup(store)
    const entries = again.list.getSnapshot().entries
    expect(entries.map((e) => e.id)).toEqual(['paired:RT1', 'local:/home/me/alpha', 'local:/home/me/beta'])
    expect(entries[1]).toMatchObject({ kind: 'local', root: '/home/me/alpha', name: 'Alpha' })
    expect(entries[0]).toMatchObject({ kind: 'paired', runtimeId: 'RT1', endpoints: [{ kind: 'lan', address: '10.0.0.2', port: 4000 }] })
    expect(await again.list.known.get('RT1')).toEqual(key)
  })

  it('a new workspace joins last in a list whose file names no order', async () => {
    const store = createMemoryDeviceStore()
    await store.set(WORKSPACES_DOCUMENT, {
      local: [{ root: '/old', name: 'old', lastOpenedAt: 1 }, { root: '/newer', name: 'newer', lastOpenedAt: 2 }],
      machine: [], paired: [], order: [],
    })
    const { list } = await setup(store)
    expect(list.getSnapshot().entries.map((e) => e.id)).toEqual(['local:/newer', 'local:/old'])
    await list.addLocal('/added')
    expect(list.getSnapshot().entries.map((e) => e.id)).toEqual(['local:/newer', 'local:/old', 'local:/added'])
  })

  it('keeps every workspace until it is closed, however many there are', async () => {
    const { list } = await setup()
    for (let i = 0; i < 35; i++) await list.addLocal(`/w/${i}`)
    // Another window may show any of them: none drops out on its own.
    expect(list.getSnapshot().entries).toHaveLength(35)
  })

  it('opens a workspace as a connection', async () => {
    const { list, connections } = await setup()
    const entry = await list.addLocal('/w')
    const connection = await list.open(entry.id)
    expect(connection.target).toEqual({ kind: 'local', root: '/w' })
    expect(connections.get(entry.id)).toBe(connection)
    expect(tryRuntimeFor(entry.id)).toBe(connection.runtime)
    expect(list.getSnapshot().open).toEqual([entry.id])
  })

  const kinds = {
    local: (list: WorkspaceList) => list.addLocal('/w/app'),
    machine: (list: WorkspaceList) => list.addMachine({ kind: 'ssh', target: { destination: 'u@box' } }, '/srv/app'),
    paired: (list: WorkspaceList) => list.addPaired({ runtimeId: 'RT3', name: 'Box', endpoints: [{ kind: 'connect' }], publicKey: key }),
  }

  for (const [kind, add] of Object.entries(kinds)) {
    it(`a ${kind} workspace: open, reconnect, close`, async () => {
      const { store, list } = await setup()
      const other = await list.addLocal('/w/other')
      await list.open(other.id)
      const entry = await add(list)
      const ids = () => list.getSnapshot().entries.map((e) => e.id)
      await list.open(entry.id)
      expect(ids()).toEqual([other.id, entry.id])
      expect(list.getSnapshot().open).toEqual([other.id, entry.id])

      // Reconnecting keeps it in its place.
      await list.reorder([entry.id, other.id])
      list.disconnect(entry.id)
      expect(list.getSnapshot().open).toEqual([other.id])
      expect(ids()).toEqual([entry.id, other.id])
      const connection = await list.open(entry.id)
      expect(ids()).toEqual([entry.id, other.id])

      // Closing disconnects it and drops it, from the file too; a paired
      // one loses its pinned key.
      await list.close(entry.id)
      expect(connection.state.kind).toBe('closed')
      expect(ids()).toEqual([other.id])
      expect(list.getSnapshot().open).toEqual([other.id])
      expect((await setup(store)).list.getSnapshot().entries.map((e) => e.id)).toEqual([other.id])
      if (entry.kind === 'paired') expect(await list.known.get(entry.runtimeId)).toBeUndefined()
    })
  }

  it('closing the last one leaves an empty file', async () => {
    const { store, list } = await setup()
    const entry = await list.addPaired({ runtimeId: 'RT2', name: 'Box', endpoints: [{ kind: 'connect' }], publicKey: key })
    await list.open(entry.id)
    await list.close(entry.id)
    expect(await store.get(KNOWN_RUNTIMES_DOCUMENT)).toEqual({ runtimes: {} })
    expect(await store.get(WORKSPACES_DOCUMENT)).toEqual({ local: [], machine: [], paired: [], order: [] })
  })

  it('disconnects a workspace another window closed', async () => {
    const { store, list } = await setup()
    const entry = await list.addLocal('/w')
    await list.open(entry.id)
    store.change(WORKSPACES_DOCUMENT, { local: [], machine: [], paired: [], order: [] })
    expect(list.get(entry.id)).toBeUndefined()
    expect(list.getSnapshot().open).toEqual([])
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
