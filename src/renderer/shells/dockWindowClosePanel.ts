// =============================================================================
// closeDockWindowPanel — the detached shell's close-tab flow. Mirrors
// closePanelWithConfirm's confirmation matrix (canvas panels route through
// confirmCloseCanvas so their children get the move/delete/cancel fan-out;
// every other panel goes through the dirty-editor / running-terminal gates)
// but keeps the shell's own teardown mechanics: the panel is undocked from
// THIS shell's dock store — the workspace dock registry can point at another
// window's tree when several dock windows share a workspace — and content is
// torn down with 'close' semantics via removePanelFromWindow.
//
// Returns true when the panel was closed, false when the user cancelled; the
// shell decides window.close() from its own dock-empty state afterwards.
// =============================================================================

import { useAppStore } from '../stores/appStore'
import type { createDockStore } from '../stores/dockStore'
import { closePanelsWithConfirm } from '../lib/closePanelWithConfirm'
import { removePanelFromWindow } from '../lib/panels/removePanelFromWindow'

export async function closeDockWindowPanel(
  workspaceId: string,
  panelId: string,
  dockStore: ReturnType<typeof createDockStore>,
): Promise<boolean> {
  return closeDockWindowPanels(workspaceId, [panelId], dockStore)
}

export async function closeDockWindowPanels(
  workspaceId: string,
  panelIds: string[],
  dockStore: ReturnType<typeof createDockStore>,
): Promise<boolean> {
  return closePanelsWithConfirm(workspaceId, panelIds, (panelId) => {
    const panel = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)?.panels[panelId]
    dockStore.getState().undockPanel(panelId)
    if (panel) removePanelFromWindow(workspaceId, panelId, panel.type, 'close')
  })
}
