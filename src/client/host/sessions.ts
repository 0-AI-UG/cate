// Where views get their session channels: the open workspace connections,
// attached once by the client core (`attachSessions`); tests attach a fake.

import type { SessionHandle } from '@client/connections'

/** The part of `WorkspaceConnections` the host uses. */
export interface ConnectionLookup {
  get(workspaceId: string): { subscribeSession(panelId: string): SessionHandle } | undefined
  subscribe(listener: () => void): () => void
}

let connections: ConnectionLookup | null = null
const listeners = new Set<() => void>()
let unsubscribe: (() => void) | null = null

const changed = () => {
  for (const listener of [...listeners]) {
    try { listener() } catch { /* isolate listeners */ }
  }
}

/** Views acquire their sessions from `next` until the returned stop. */
export function attachSessions(next: ConnectionLookup): () => void {
  unsubscribe?.()
  connections = next
  unsubscribe = next.subscribe(changed)
  changed()
  return () => {
    if (connections !== next) return
    unsubscribe?.()
    unsubscribe = null
    connections = null
    changed()
  }
}

/** A new reference on the panel's session channel, or null while the
 *  workspace has no connection. */
export function acquireSession<S = unknown>(workspaceId: string, panelId: string): SessionHandle<S> | null {
  return (connections?.get(workspaceId)?.subscribeSession(panelId) as SessionHandle<S> | undefined) ?? null
}

/** Called when connections open or close. */
export function subscribeSessions(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** What issues the workspace's handles (its connection), or null. A view
 *  keeps its handle while this stays the same, so another workspace's
 *  connection opening or closing never detaches it. */
export function sessionOwner(workspaceId: string): unknown {
  return connections?.get(workspaceId) ?? null
}
