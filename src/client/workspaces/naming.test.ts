import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceConnections } from '@client/connections'
import { nameJoinedWorkspaces, placeholderName } from './naming'
import type { WorkspaceList } from './workspaceList'

function fakes(name: string) {
  const entry = { kind: 'paired' as const, id: 'paired:abcd1234', runtimeId: 'abcd1234', name }
  let state = { kind: 'connecting' }
  const listeners = new Set<() => void>()
  const info = vi.fn(async () => ({ runtimeId: 'abcd1234', root: '/home/me/project', name: 'project' }))
  const connection = {
    workspaceId: entry.id,
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    runtime: { workspace: { info } },
  }
  const workspaces = {
    get: () => entry,
    rename: vi.fn(async (_id: string, next: string) => { entry.name = next }),
  }
  const connections = { getSnapshot: () => [connection], subscribe: () => () => {} }
  const connect = () => { state = { kind: 'connected' }; for (const listener of listeners) listener() }
  return { entry, info, workspaces, connections, connect }
}

describe('nameJoinedWorkspaces', () => {
  it('names a joined workspace after its runtime folder once it connects', async () => {
    const f = fakes(placeholderName('abcd1234'))
    nameJoinedWorkspaces(f.workspaces as unknown as WorkspaceList, f.connections as unknown as WorkspaceConnections)
    expect(f.info).not.toHaveBeenCalled()
    f.connect()
    await vi.waitFor(() => expect(f.entry.name).toBe('project'))
  })

  it('never replaces a name the person gave', async () => {
    const f = fakes('My project')
    nameJoinedWorkspaces(f.workspaces as unknown as WorkspaceList, f.connections as unknown as WorkspaceConnections)
    f.connect()
    await Promise.resolve()
    expect(f.info).not.toHaveBeenCalled()
    expect(f.workspaces.rename).not.toHaveBeenCalled()
  })
})
