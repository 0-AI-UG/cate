// A joined workspace is listed under a placeholder until its runtime first
// answers; then it takes the runtime's folder name. A name the person gave it
// is never replaced.

import type { WorkspaceConnections } from '@client/connections'
import type { WorkspaceList } from './workspaceList'

export function placeholderName(runtimeId: string): string {
  return `Workspace ${runtimeId.slice(0, 4).toUpperCase()}`
}

/** Names joined workspaces after their runtime's folder as they connect.
 *  Returns the uninstall. */
export function nameJoinedWorkspaces(workspaces: WorkspaceList, connections: WorkspaceConnections): () => void {
  const asked = new Set<string>()
  const wired = new Map<object, () => void>()
  const check = () => {
    for (const connection of connections.getSnapshot()) {
      const id = connection.workspaceId
      const entry = workspaces.get(id)
      if (entry?.kind !== 'paired' || entry.name !== placeholderName(entry.runtimeId)) continue
      if (asked.has(id) || connection.getState().kind !== 'connected') continue
      asked.add(id)
      connection.runtime.workspace.info()
        .then((info) => {
          const current = workspaces.get(id)
          if (info.name && current?.kind === 'paired' && current.name === placeholderName(current.runtimeId)) {
            return workspaces.rename(id, info.name)
          }
        })
        .catch(() => { asked.delete(id) })
    }
  }
  const rewire = () => {
    const live = new Set<object>(connections.getSnapshot())
    for (const connection of connections.getSnapshot()) {
      if (!wired.has(connection)) wired.set(connection, connection.subscribe(check))
    }
    for (const [connection, stop] of wired) {
      if (live.has(connection)) continue
      wired.delete(connection)
      stop()
    }
    check()
  }
  const stop = connections.subscribe(rewire)
  rewire()
  return () => {
    stop()
    for (const off of wired.values()) off()
    wired.clear()
  }
}
