// =============================================================================
// confirmCloseCanvas — prompts the user before closing a canvas panel.
//
// If the workspace has another canvas and the closing canvas holds panels, the
// user is offered to move those panels to another canvas or delete them. If
// this is the only (or an empty) canvas, a simple close/cancel prompt runs.
//
// Returns true when the caller should proceed to closePanel() the canvas.
// When 'move' or 'delete' is chosen, this helper performs the panel fan-out
// itself before returning true.
// =============================================================================

import type { DockLayoutNode } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { getOrCreateCanvasStoreForPanel } from '../../stores/canvasStore'
import { getNodeDockLayout } from '../workspace/canvasAccess'

/** Walk a per-node dock layout tree and collect every panelId inside it. */
function collectPanelIds(layout: DockLayoutNode | null | undefined): string[] {
  if (!layout) return []
  if (layout.type === 'tabs') return [...layout.panelIds]
  const out: string[] = []
  for (const child of layout.children) out.push(...collectPanelIds(child))
  return out
}

export async function confirmCloseCanvas(
  workspaceId: string,
  canvasPanelId: string,
): Promise<boolean> {
  const appState = useAppStore.getState()
  const ws = appState.workspaces.find((w) => w.id === workspaceId)
  if (!ws) return true

  const canvasPanelIds = Object.values(ws.panels)
    .filter((p) => p.type === 'canvas')
    .map((p) => p.id)
  const isLast = canvasPanelIds.length <= 1

  // Enumerate every panel that currently lives on the closing canvas by walking
  // each canvas node's dockLayout. Fall back to the node's seed panelId if the
  // dock layout is missing (shouldn't happen in practice, but keeps us honest).
  const sourceStore = getOrCreateCanvasStoreForPanel(canvasPanelId)
  const sourceNodes = Object.values(sourceStore.getState().nodes)
  const contained: Array<{ panelId: string; origin: { x: number; y: number } }> = []
  for (const node of sourceNodes) {
    // Read the live mini-dock layout when the node is mounted (the resolver
    // falls back to the persisted node.dockLayout projection otherwise).
    const layoutPanels = collectPanelIds(getNodeDockLayout(canvasPanelId, node.id))
    const panelIds = layoutPanels.length > 0 ? layoutPanels : [node.panelId]
    for (const pid of panelIds) {
      if (ws.panels[pid]) contained.push({ panelId: pid, origin: node.origin })
    }
  }

  if (!window.electronAPI?.confirmCloseCanvas) return true

  const choice = await window.electronAPI.confirmCloseCanvas({
    panelCount: contained.length,
    isLast,
  })

  if (choice === 'cancel') return false

  if (choice === 'close') {
    // Last or empty canvas. Close any panels it contains too — they live ON
    // this canvas, so letting them outlive it leaves orphans that render as
    // ghost rows in the sidebar and aren't shown on any canvas. (Empty canvas
    // → `contained` is empty → no-op.)
    for (const { panelId } of contained) {
      try { appState.closePanel(workspaceId, panelId) } catch { /* continue */ }
    }
    return true
  }

  if (choice === 'delete') {
    // Close every panel living on this canvas. The canvas panel itself will be
    // closed by the caller via closePanel().
    for (const { panelId } of contained) {
      try { appState.closePanel(workspaceId, panelId) } catch { /* continue */ }
    }
    return true
  }

  if (choice === 'move') {
    // Find another canvas to move panels into.
    const targetCanvasId = canvasPanelIds.find((id) => id !== canvasPanelId)
    if (!targetCanvasId) return true // defensive — shouldn't happen when !isLast
    const targetStore = getOrCreateCanvasStoreForPanel(targetCanvasId)

    for (const { panelId, origin } of contained) {
      const panel = ws.panels[panelId]
      if (!panel) continue
      // Re-home each panel as its own fresh node on the target canvas. This
      // preserves spatial position but flattens any nested dock layouts into
      // individual nodes — a deliberate simplification over deep layout copy.
      try {
        targetStore.getState().addNode(panelId, panel.type, origin)
      } catch { /* swallow and continue */ }
    }
    return true
  }

  return false
}
