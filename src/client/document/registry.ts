// The document store and client state of each open workspace, looked up by
// workspaceId. `attachDocuments` keeps them in step with the open connections.

import type { WorkspaceConnection, WorkspaceConnections } from '@client/connections'
import { createClientStateStore, type ClientStateStore } from './clientState'
import { reportPresence } from './presence'
import { createDocumentStore, type DocumentStore } from './store'

interface Open {
  connection: WorkspaceConnection
  document: DocumentStore
  state: ClientStateStore
  stop: () => void
}

const open = new Map<string, Open>()
const listeners = new Set<() => void>()
let version = 0

const changed = () => {
  version++
  for (const listener of [...listeners]) {
    try { listener() } catch { /* isolate listeners */ }
  }
}

export function documentStoreFor(workspaceId: string): DocumentStore | null {
  return open.get(workspaceId)?.document ?? null
}

export function clientStateFor(workspaceId: string): ClientStateStore | null {
  return open.get(workspaceId)?.state ?? null
}

/** The workspaces with a document store, in attach order. */
export function documentWorkspaceIds(): string[] {
  return [...open.keys()]
}

export function subscribeDocumentStores(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function documentStoresVersion(): number {
  return version
}

/** Builds the document mirror, client state and presence reporting of a
 *  connection. Returns a function that tears them down. */
export function attachDocument(connection: WorkspaceConnection): () => void {
  const onReady = (listener: (info: { reconnect: boolean }) => void) => connection.rpc.onReady(listener)
  const document = createDocumentStore({
    clientId: connection.clientId,
    remote: connection.runtime.document,
    onReady,
  })
  const state = createClientStateStore()
  const stopPresence = reportPresence(state, { report: (p) => connection.runtime.presence.report(p), onReady })
  const entry: Open = {
    connection,
    document,
    state,
    stop: () => {
      stopPresence()
      document.dispose()
    },
  }
  open.get(connection.workspaceId)?.stop()
  open.set(connection.workspaceId, entry)
  changed()
  return () => {
    if (open.get(connection.workspaceId) !== entry) return
    open.delete(connection.workspaceId)
    entry.stop()
    changed()
  }
}

/** Keeps one document mirror per open connection. */
export function attachDocuments(connections: WorkspaceConnections): () => void {
  const attached = new Map<WorkspaceConnection, () => void>()
  const sync = () => {
    const current = new Set(connections.getSnapshot())
    for (const [connection, detach] of attached) {
      if (current.has(connection)) continue
      attached.delete(connection)
      detach()
    }
    for (const connection of current) {
      if (!attached.has(connection)) attached.set(connection, attachDocument(connection))
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
