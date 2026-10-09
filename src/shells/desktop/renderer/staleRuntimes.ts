// A runtime that runs another build of the same protocol (an older install,
// or a checkout's runtime before `runtime:dev` installed the new one) still
// connects (7.10). The desktop restarts it into its own build once per
// connection, whatever the transport, and only while nothing else uses it:
// the runtime refuses (`dirty`) when another client is connected or work
// runs, or when its machine cannot get that build, and then it keeps running
// as it is.

import type { WorkspaceConnection, WorkspaceConnections } from '@client/connections'

export function restartStaleRuntimes(
  deps: { connections: WorkspaceConnections; version: string; build: string | undefined },
): () => void {
  const { build } = deps
  if (!build) return () => {}
  const tried = new WeakSet<WorkspaceConnection>()
  const watched = new Map<WorkspaceConnection, () => void>()
  const check = (connection: WorkspaceConnection) => {
    const { state } = connection
    if (state.kind !== 'connected' || !state.stale || tried.has(connection)) return
    tried.add(connection)
    connection.runtime.runtime.update({ version: deps.version, build, ifIdle: true }).catch(() => { /* in use: keep it */ })
  }
  const sync = () => {
    const current = new Set(deps.connections.getSnapshot())
    for (const [connection, off] of watched) {
      if (current.has(connection)) continue
      off()
      watched.delete(connection)
    }
    for (const connection of current) {
      if (watched.has(connection)) continue
      watched.set(connection, connection.subscribe(() => check(connection)))
      check(connection)
    }
  }
  const stop = deps.connections.subscribe(sync)
  sync()
  return () => {
    stop()
    for (const off of watched.values()) off()
    watched.clear()
  }
}
