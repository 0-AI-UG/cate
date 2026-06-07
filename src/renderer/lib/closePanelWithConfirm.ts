// =============================================================================
// closePanelWithConfirm — the single entry point for closing one panel with the
// right confirmation flow for its type. Canvas panels route through
// confirmCloseCanvas (move/delete/cancel for the children they host); every
// other panel goes through the dirty-editor / running-terminal gates.
//
// Centralising this keeps every close affordance (dock tab, sidebar row,
// context menu) consistent — in particular, closing a canvas always offers to
// move or close its children instead of silently orphaning them.
// =============================================================================

import { useAppStore } from '../stores/appStore'
import { confirmClosePanels } from './confirmClosePanels'
import { confirmCloseCanvas } from './canvas/confirmCloseCanvas'

/** Returns true when the panel was closed, false when the user cancelled. */
export async function closePanelWithConfirm(
  workspaceId: string,
  panelId: string,
): Promise<boolean> {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
  const panel = ws?.panels[panelId]

  if (panel?.type === 'canvas') {
    // confirmCloseCanvas fans out the children (move/delete) itself, then we
    // close the canvas panel. It returns false on cancel.
    if (!(await confirmCloseCanvas(workspaceId, panelId))) return false
    useAppStore.getState().closePanel(workspaceId, panelId)
    return true
  }

  if (!(await confirmClosePanels(workspaceId, [panelId]))) return false
  useAppStore.getState().closePanel(workspaceId, panelId)
  return true
}
