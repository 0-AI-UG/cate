// =============================================================================
// movePanelToNewWindow — detach a panel into its own window from ANY location.
//
// The dock tab menu (useDockTabActions.moveTabToNewWindow) and the drag system
// (drag/commit.ts 'detach') are stack-/drag-relative: they already know which
// dock store or canvas node the panel is leaving. This helper is the
// location-agnostic version for callers that only have a panel id (the sidebar
// workspace overview, the command palette): it resolves the panel's location via
// the canonical probe (resolvePanelLocation), builds the same transfer snapshot,
// asks main to spawn the window, and only then removes the panel from its source
// — mirroring the "detach first, tear down after" rule of both existing paths.
// =============================================================================

import type { PanelLocation } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { getOrCreateCanvasStoreForPanel } from '../../stores/canvasStore'
import { getNodeDockStore, getLiveNodeDockLayout } from '../../panels/nodeDockRegistry'
import { collectPanelIds } from '../../../shared/collectPanelIds'
import { createTransferSnapshot } from '../panelTransfer'
import { removePanelFromWindow } from '../panels/removePanelFromWindow'
import { getWorkspaceDockStore } from './dockRegistry'
import { resolvePanelLocation } from './canvasAccess'

/** Detach `panelId` into a new window. Returns true when the window was
 *  created; false when the panel can't be located or main refused the detach
 *  (e.g. macOS fullscreen) — in which case the source is left untouched. */
export async function movePanelToNewWindow(
  workspaceId: string,
  panelId: string,
): Promise<boolean> {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
  const panel = ws?.panels[panelId]
  if (!ws || !panel) return false
  if (!window.electronAPI?.dragDetach) return false

  const location = resolvePanelLocation(workspaceId, panelId)
  if (!location) return false

  let sourceLocation: PanelLocation
  let nodeId: string | null = null
  if (location.kind === 'dock') {
    sourceLocation = { type: 'dock', zone: location.zone, stackId: location.stackId }
  } else {
    const canvasStore = getOrCreateCanvasStoreForPanel(location.canvasPanelId)
    nodeId = canvasStore.getState().nodeForPanel(panelId)
    if (!nodeId) return false
    sourceLocation = { type: 'canvas', canvasId: location.canvasPanelId, canvasNodeId: nodeId }
  }

  const snapshot = createTransferSnapshot(
    panel,
    sourceLocation,
    { origin: { x: 100, y: 100 }, size: { width: 800, height: 600 } },
    {
      // A canvas panel carries its children; without this the new window
      // renders them as generic "Panel" stubs (mirrors the dock tab path).
      resolveChildPanel: (childId: string) => ws.panels[childId],
      workspaceRootPath: ws.rootPath || undefined,
      worktrees: ws.worktrees,
    },
  )

  // Detach FIRST — only tear down the source once the new window actually
  // exists (dragDetach returns null when main refuses).
  const winId = await window.electronAPI.dragDetach(snapshot, workspaceId)
  if (winId == null) return false

  if (location.kind === 'dock') {
    getWorkspaceDockStore(workspaceId)?.getState().undockPanel(panelId)
  } else if (nodeId) {
    // A canvas node may host several tabbed panels — only remove the whole
    // node when this panel is its sole occupant; otherwise undock just its tab.
    const canvasStore = getOrCreateCanvasStoreForPanel(location.canvasPanelId)
    const layout =
      getLiveNodeDockLayout(location.canvasPanelId, nodeId) ??
      canvasStore.getState().nodes[nodeId]?.dockLayout ??
      null
    const nodeDock = getNodeDockStore(location.canvasPanelId, nodeId)
    if (collectPanelIds(layout).length > 1 && nodeDock) {
      nodeDock.getState().undockPanel(panelId)
    } else {
      canvasStore.getState().finalizeRemoveNode(nodeId)
    }
  }

  // Release its content (PTYs keep running, mid-transfer) and drop its record
  // (and a canvas's children) from this workspace so every system — overview,
  // command palette, session, counts — agrees it's no longer here.
  removePanelFromWindow(workspaceId, panelId, panel.type, 'transfer')

  // Detaching the workspace's only canvas leaves an empty center dock — mint a
  // fresh one, mirroring the drag-detach path (useDragOp.onRemovedFromCanvas).
  if (panel.type === 'canvas') {
    const app = useAppStore.getState()
    const remaining = Object.values(
      app.workspaces.find((w) => w.id === workspaceId)?.panels ?? {},
    ).filter((p) => p.type === 'canvas')
    if (remaining.length === 0) app.createCanvas(workspaceId)
  }
  return true
}
