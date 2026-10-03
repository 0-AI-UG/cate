// Where views get their session channels: the open workspace connections.
// The client's entry installs them; tests install a fake.

import type { SessionHandle } from '@client/connections'

export interface SessionSource {
  /** A new reference on the panel's session channel, or null while the
   *  workspace has no connection. */
  acquire(workspaceId: string, panelId: string): SessionHandle | null
  /** What issues the workspace's handles (its connection), or null. A view
   *  keeps its handle while this stays the same, so another workspace's
   *  connection opening or closing never detaches it. */
  owner(workspaceId: string): unknown
  /** Called when connections open or close. */
  subscribe(listener: () => void): () => void
}

/** The part of `WorkspaceConnections` the host uses. */
export interface ConnectionLookup {
  get(workspaceId: string): { subscribeSession(panelId: string): SessionHandle } | undefined
  subscribe(listener: () => void): () => void
}

let source: SessionSource | null = null
const listeners = new Set<() => void>()
let unsubscribe: (() => void) | null = null

const changed = () => {
  for (const listener of [...listeners]) {
    try { listener() } catch { /* isolate listeners */ }
  }
}

export function installSessionSource(next: SessionSource | null): void {
  unsubscribe?.()
  source = next
  unsubscribe = next ? next.subscribe(changed) : null
  changed()
}

export function sessionSourceFrom(connections: ConnectionLookup): SessionSource {
  return {
    acquire: (workspaceId, panelId) => connections.get(workspaceId)?.subscribeSession(panelId) ?? null,
    owner: (workspaceId) => connections.get(workspaceId) ?? null,
    subscribe: (listener) => connections.subscribe(listener),
  }
}

export function acquireSession(workspaceId: string, panelId: string): SessionHandle | null {
  return source?.acquire(workspaceId, panelId) ?? null
}

export function subscribeSessionSource(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The current owner of the workspace's session handles (see
 *  `SessionSource.owner`); changes when its connection or the source does. */
export function sessionOwner(workspaceId: string): unknown {
  return source?.owner(workspaceId) ?? null
}
