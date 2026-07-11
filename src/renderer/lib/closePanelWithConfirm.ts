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
import { confirmCloseDirtyPanels } from './confirmCloseDirty'
import { confirmCloseRunningTerminals } from './confirmCloseTerminal'
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

/** Close every panel in a workspace behind the same dirty-editor /
 *  running-terminal gates as a single close (one aggregate dialog per gate).
 *  Returns true when the panels were closed, false when the user cancelled. */
export async function closeAllPanelsWithConfirm(workspaceId: string): Promise<boolean> {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
  if (!ws) return true
  if (!(await confirmClosePanels(workspaceId, Object.keys(ws.panels)))) return false
  useAppStore.getState().closeAllPanels(workspaceId)
  return true
}

/** Close whole workspaces (single close and bulk delete share this) behind ONE
 *  aggregate confirmation covering every panel they host — removeWorkspace
 *  itself tears panels down unconditionally, so the gates must run here first.
 *  Forgets the workspaces' projects from recents (user-initiated close).
 *  Returns true when the workspaces were removed, false when the user cancelled. */
export async function removeWorkspacesWithConfirm(workspaceIds: string[]): Promise<boolean> {
  const app = useAppStore.getState()
  const panels = workspaceIds.flatMap((id) =>
    Object.values(app.workspaces.find((w) => w.id === id)?.panels ?? {}),
  )
  if (!(await confirmCloseDirtyPanels(panels))) return false
  if (!(await confirmCloseRunningTerminals(panels))) return false
  for (const id of workspaceIds) {
    useAppStore.getState().removeWorkspace(id, true)
  }
  return true
}
