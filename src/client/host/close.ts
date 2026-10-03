// Closing panels from generic UI (a tab's close button, Cmd+W, a window's
// close). The view side asks the user before anything destructive (11.2 rule
// 6): each panel type's view module registers a close guard, which runs with
// a session handle whether or not the view is mounted. Then one
// `removePanels` op goes to the runtime.

import { removalSet, type PanelId, type PanelRecord } from '@workspace/document/contract'
import type { SessionHandle } from '@client/connections'
import { documentStoreFor } from '@client/document'
import { acquireSession } from './sessions'

export interface CloseGuardContext {
  workspaceId: string
  record: PanelRecord
  /** The panel's session channel, held for the guard's duration. */
  session: SessionHandle | null
  /** Every panel this close removes (a canvas takes the panels on it). */
  closing: ReadonlySet<PanelId>
}

/** Resolves false to keep the panel. It may send session ops first (save,
 *  discard) with the user's answer. */
export type CloseGuard = (context: CloseGuardContext) => Promise<boolean> | boolean

const guards = new Map<string, CloseGuard>()

export function registerPanelCloseGuard(type: string, guard: CloseGuard): () => void {
  guards.set(type, guard)
  return () => { if (guards.get(type) === guard) guards.delete(type) }
}

/** Asks every guard for the panels a close would remove, in document order.
 *  Resolves false when any declines. */
export async function confirmClose(workspaceId: string, ids: readonly PanelId[]): Promise<boolean> {
  const store = documentStoreFor(workspaceId)
  const doc = store?.getSnapshot()
  if (!store || !doc) return false
  const known = ids.filter((id) => doc.panels[id])
  let closing = removalSet(doc, known)
  for (const id of [...closing]) {
    // A guard may move panels out of the close (a canvas moving its panels
    // to another canvas): those are no longer asked about.
    if (!closing.has(id)) continue
    const record = doc.panels[id]
    const guard = record ? guards.get(record.type) : undefined
    if (!record || !guard) continue
    const session = acquireSession(workspaceId, id)
    try {
      if (!(await guard({ workspaceId, record, session, closing }))) return false
    } finally {
      session?.release()
    }
    const now = store.getSnapshot()
    closing = removalSet(now, known.filter((known) => now.panels[known]))
  }
  return true
}

/** Closes panels after their guards agree. Resolves true once the op went. */
export async function closePanels(workspaceId: string, ids: readonly PanelId[]): Promise<boolean> {
  if (ids.length === 0) return false
  if (!(await confirmClose(workspaceId, ids))) return false
  const store = documentStoreFor(workspaceId)
  const doc = store?.getSnapshot()
  const remaining = ids.filter((id) => doc?.panels[id])
  if (!store || !doc || remaining.length === 0) return false
  return store.propose({ kind: 'removePanels', ids: remaining }).ok
}

export function closePanel(workspaceId: string, panelId: PanelId): Promise<boolean> {
  return closePanels(workspaceId, [panelId])
}
