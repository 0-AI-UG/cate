import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionState, WorkspaceConnection } from './connection'
import type { WorkspaceConnections } from './registry'
import { createRuntimeUpdates, runtimeMismatch, type RuntimeUpdates } from './runtimeUpdate'

let updates: RuntimeUpdates | null = null
afterEach(() => { updates?.dispose(); updates = null })

function fakeConnection(state: ConnectionState, idle = true) {
  const listeners = new Set<() => void>()
  const update = vi.fn(async (params: { ifIdle?: boolean }) => {
    if (params.ifIdle && !idle) throw Object.assign(new Error('the runtime has other clients or running work'), { code: 'dirty' })
  })
  const connection = {
    state,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
    runtime: { runtime: { update, info: vi.fn(async () => ({ pid: 1 })), updateProgress: vi.fn(async () => null) } },
    set(next: ConnectionState) {
      connection.state = next
      for (const l of [...listeners]) l()
    },
  }
  return connection
}

const start = (...all: ReturnType<typeof fakeConnection>[]) => {
  const connections = { getSnapshot: () => all as unknown as WorkspaceConnection[], subscribe: () => () => {} } as unknown as WorkspaceConnections
  updates = createRuntimeUpdates({ connections, version: '2.0.4', build: '2.0.4+b' })
  return updates
}
const as = (c: ReturnType<typeof fakeConnection>) => c as unknown as WorkspaceConnection

it('tells which side a mismatch updates: never a newer runtime back', () => {
  expect(runtimeMismatch({ kind: 'incompatible', runtimeVersion: '2.0.3' }, '2.0.4')).toEqual({ update: 'runtime', runtimeVersion: '2.0.3', appVersion: '2.0.4' })
  expect(runtimeMismatch({ kind: 'incompatible', runtimeVersion: '2.1.0-beta.1' }, '2.0.4')).toMatchObject({ update: 'app' })
  expect(runtimeMismatch({ kind: 'connected' }, '2.0.4')).toBeNull()
})

it('updates an older runtime nothing uses without asking, and waits through its restart', async () => {
  const older = fakeConnection({ kind: 'incompatible', runtimeVersion: '2.0.3' })
  const runtimeUpdates = start(older)
  expect(older.runtime.runtime.update).toHaveBeenCalledWith({ version: '2.0.4', build: '2.0.4+b', ifIdle: true })
  await vi.waitFor(() => expect(runtimeUpdates.run(as(older))).toEqual({ phase: 'restarting' }))
  older.set({ kind: 'offline', lastSeen: 1, retrying: true })
  expect(runtimeUpdates.run(as(older))).toEqual({ phase: 'restarting' })
  older.set({ kind: 'connected' })
  await vi.waitFor(() => expect(runtimeUpdates.run(as(older))).toBeNull())
})

it('tries without asking once per incompatible spell; in use, it is left to the person', async () => {
  const busy = fakeConnection({ kind: 'incompatible', runtimeVersion: '2.0.3' }, false)
  const runtimeUpdates = start(busy)
  await vi.waitFor(() => expect(runtimeUpdates.run(as(busy))).toBeNull())
  busy.set({ kind: 'incompatible', runtimeVersion: '2.0.3' })
  expect(busy.runtime.runtime.update).toHaveBeenCalledTimes(1)
  // Asked: the update goes without `ifIdle`.
  const asked = runtimeUpdates.update(as(busy))
  expect(busy.runtime.runtime.update).toHaveBeenLastCalledWith({ version: '2.0.4', build: '2.0.4+b' })
  await vi.waitFor(() => expect(runtimeUpdates.run(as(busy))).toEqual({ phase: 'restarting' }))
  busy.set({ kind: 'connected' })
  await expect(asked).resolves.toBeNull()
  // A new spell (another runtime came up) tries again.
  busy.set({ kind: 'incompatible', runtimeVersion: '2.0.2' })
  expect(busy.runtime.runtime.update).toHaveBeenCalledTimes(3)
})

it('never touches a runtime newer than this client', () => {
  const newer = fakeConnection({ kind: 'incompatible', runtimeVersion: '2.1.0' })
  const runtimeUpdates = start(newer)
  expect(newer.runtime.runtime.update).not.toHaveBeenCalled()
  expect(runtimeUpdates.run(as(newer))).toBeNull()
})
