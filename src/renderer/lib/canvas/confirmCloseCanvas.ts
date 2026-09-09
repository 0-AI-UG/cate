// =============================================================================
// confirmCloseCanvas — prompts the user before closing a canvas panel.
//
// If the workspace has another canvas and the closing canvas holds panels, the
// user is offered to move those panels to another canvas or delete them. If
// this is the only (or an empty) canvas, a simple close/cancel prompt runs.
//
// Preparation gathers the user's disposition without changing placement.
// Single and bulk callers confirm affected panels before committing the plan.
// =============================================================================

import { confirmClosePanels } from '../confirmClosePanels'
import { useAppStore } from '../../stores/appStore'
import { getOrCreateCanvasStoreForPanel } from '../../stores/canvasStore'
import { getNodeDockLayout } from '../workspace/canvasAccess'
import { collectPanelIds } from '../../../shared/collectPanelIds'

export interface CanvasClosePlan {
  closingPanelIds: string[]
  apply(): boolean
}

/** Ask for a canvas disposition without moving or deleting its children. */
export async function prepareCloseCanvas(
  workspaceId: string,
  canvasPanelId: string,
  closingCanvasIds: readonly string[] = [canvasPanelId],
): Promise<CanvasClosePlan | null> {
  const appState = useAppStore.getState()
  const ws = appState.workspaces.find((w) => w.id === workspaceId)
  if (!ws) return { closingPanelIds: [], apply: () => true }

  const canvasPanelIds = Object.values(ws.panels)
    .filter((p) => p.type === 'canvas' && !closingCanvasIds.includes(p.id))
    .map((p) => p.id)
  const isLast = canvasPanelIds.length === 0

  // Enumerate every panel that currently lives on the closing canvas by walking
  // each canvas node's dockLayout.
  const sourceStore = getOrCreateCanvasStoreForPanel(canvasPanelId)
  const sourceNodes = Object.values(sourceStore.getState().nodes)
  const contained: Array<{
    panelId: string
    nodeId: string
    origin: { x: number; y: number }
  }> = []
  for (const node of sourceNodes) {
    // Read the live mini-dock layout when the node is mounted (the resolver
    // falls back to the persisted node.dockLayout projection otherwise).
    for (const pid of collectPanelIds(getNodeDockLayout(canvasPanelId, node.id))) {
      if (ws.panels[pid]) contained.push({ panelId: pid, nodeId: node.id, origin: node.origin })
    }
  }

  if (!window.electronAPI?.confirmCloseCanvas) return { closingPanelIds: contained.map(({ panelId }) => panelId), apply: () => true }

  const choice = await window.electronAPI.confirmCloseCanvas({
    panelCount: contained.length,
    isLast,
  })

  if (choice === 'cancel') return null

  if (choice === 'close' || choice === 'delete') {
    return {
      closingPanelIds: contained.map(({ panelId }) => panelId),
      apply: () => {
        for (const { panelId } of contained) appState.closePanel(workspaceId, panelId)
        return true
      },
    }
  }

  if (choice === 'move') {
    // Find another canvas to move panels into.
    const targetCanvasId = canvasPanelIds[0]
    if (!targetCanvasId) return null // defensive — shouldn't happen when !isLast
    return {
      closingPanelIds: [],
      apply: () => {
        const targetStore = getOrCreateCanvasStoreForPanel(targetCanvasId)
        const addedTargetNodeIds: string[] = []

        try {
          for (const { panelId, origin } of contained) {
            const panel = ws.panels[panelId]
            if (!panel) continue
            // Re-home each panel as its own fresh node on the target canvas. This
            // preserves spatial position but flattens any nested dock layouts into
            // individual nodes — a deliberate simplification over deep layout copy.
            const nodeId = targetStore.getState().addNode(panelId, panel.type, origin)
            if (!nodeId) throw new Error(`Failed to move panel ${panelId}`)
            addedTargetNodeIds.push(nodeId)
          }
        } catch {
          for (const nodeId of addedTargetNodeIds) {
            targetStore.getState().finalizeRemoveNode(nodeId)
          }
          return false
        }

        // Closing a canvas tears down every panel it still owns. Drop the source
        // nodes immediately so the caller's closePanel(canvasPanelId) cannot also
        // tear down the children that now belong to the target canvas.
        for (const nodeId of new Set(contained.map(({ nodeId }) => nodeId))) {
          sourceStore.getState().finalizeRemoveNode(nodeId)
        }
        return true
      },
    }
  }

  return null
}

/** Single closes use the same plan and aggregate gates as bulk closes. */
export async function confirmCloseCanvas(workspaceId: string, canvasPanelId: string): Promise<boolean> {
  const plan = await prepareCloseCanvas(workspaceId, canvasPanelId)
  if (!plan || !(await confirmClosePanels(workspaceId, plan.closingPanelIds))) return false
  return plan.apply()
}
