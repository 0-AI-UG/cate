// Runs `attach` once for each open connection and its detach when the
// connection goes (closed, or the registry disposed).

import type { WorkspaceConnection, WorkspaceConnections } from '@client/connections'

export function eachConnection(
  connections: Pick<WorkspaceConnections, 'getSnapshot' | 'subscribe'>,
  attach: (connection: WorkspaceConnection) => () => void,
): () => void {
  const attached = new Map<WorkspaceConnection, () => void>()
  const sync = () => {
    const current = new Set(connections.getSnapshot())
    for (const [connection, detach] of attached) {
      if (current.has(connection)) continue
      attached.delete(connection)
      detach()
    }
    for (const connection of current) {
      if (!attached.has(connection)) attached.set(connection, attach(connection))
    }
  }
  const stop = connections.subscribe(sync)
  sync()
  return () => {
    stop()
    for (const detach of attached.values()) detach()
    attached.clear()
  }
}
