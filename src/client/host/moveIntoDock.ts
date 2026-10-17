// Moving a canvas panel into the dock: its tab goes right after the canvas
// panel showing its canvas (one `placePanel` op) and shows there, focused.

import { dockTargetOf, type PanelId } from '@workspace/document/contract'
import { clientStateFor, documentStoreFor } from '@client/document'

/** The panel sits on a canvas whose canvas panel is in a dock. */
export function canMoveIntoDock(workspaceId: string, panelId: PanelId): boolean {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  return !!doc && !!dockTargetOf(doc, panelId)
}

export function moveIntoDock(workspaceId: string, panelId: PanelId): boolean {
  const store = documentStoreFor(workspaceId)
  const at = store ? dockTargetOf(store.getSnapshot(), panelId) : null
  if (!store || !at || at.to !== 'stack') return false
  store.propose({ kind: 'placePanel', id: panelId, at })
  const state = clientStateFor(workspaceId)
  state?.setActiveTab(at.stackId, panelId)
  state?.focus(panelId)
  return true
}
