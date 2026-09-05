// =============================================================================
// Canvas Bridge — implements CanvasOperations by delegating to a canvas store.
// Connects the appStore (which manages panel lifecycle) to the canvas store
// (which manages visual layout) without a direct import dependency.
// =============================================================================

import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../../stores/canvasStore'
import type { PanelType, Point, Size, CanvasNodeId, CanvasNodeState } from '../../../shared/types'
import { findNodeDockStore } from '../../panels/nodeDockRegistry'
import { collectPanelIds } from '../../../shared/collectPanelIds'
import { removePanelFromTree } from '../../stores/dockStore'

// -----------------------------------------------------------------------------
// Canvas operations callback — the contract createCanvasOps implements, letting
// the appStore (panel lifecycle) drive a canvas store (visual layout) without a
// direct import dependency on canvasStore.
// -----------------------------------------------------------------------------

export interface CanvasOperations {
  /** Add a node and focus+center it. `focus: false` adds it in place without
   *  touching focus or the viewport (background creates). */
  addNodeAndFocus: (panelId: string, panelType: PanelType, position?: Point, size?: Size, focus?: boolean) => void
  /** Start the canonical new/existing panel-target transaction. */
  beginPanelTarget: CanvasStore['beginPanelTarget']
  removeNodeForPanel: (panelId: string) => void
  loadWorkspaceCanvas: (
    nodes: Record<CanvasNodeId, CanvasNodeState>,
    viewportOffset: Point,
    zoomLevel: number,
  ) => void
  clearAllNodes: () => void
  focusPanelNode: (panelId: string) => void
  /** Access the underlying store API (needed by session restore) */
  storeApi: StoreApi<CanvasStore>
}

export function createCanvasOps(storeApi: StoreApi<CanvasStore>): CanvasOperations {
  return {
    storeApi,

    addNodeAndFocus(panelId: string, panelType: PanelType, position?: Point, size?: Size, focus = true) {
      // addNode selects the new node as part of its interactive-create contract.
      // Background API creates must preserve the user's canvas selection too,
      // not merely skip focusAndCenter (which only preserves the camera).
      const previousSelection = focus
        ? null
        : {
            selection: storeApi.getState().selection,
            selectionActive: storeApi.getState().selectionActive,
          }
      const nodeId = storeApi.getState().addNode(panelId, panelType, position, size)
      if (focus) storeApi.getState().focusAndCenter(nodeId)
      else if (previousSelection) storeApi.setState(previousSelection)
    },

    beginPanelTarget(request) {
      return storeApi.getState().beginPanelTarget(request)
    },

    removeNodeForPanel(panelId: string) {
      const state = storeApi.getState()
      const nodeId = state.nodeForPanel(panelId)
      if (!nodeId) return
      const node = state.nodes[nodeId]
      if (!node) return
      // The live per-node DockStore is the runtime authority now; node.dockLayout
      // is only a save-time projection. Read the live layout (this runs when a
      // panel is interactively closed, so the node's mini-dock is mounted) and
      // fall back to the projection if the store isn't registered.
      const liveStore = findNodeDockStore(nodeId)
      if (liveStore) {
        liveStore.getState().undockPanel(panelId)
        const layout = liveStore.getState().zones.center.layout
        if (layout) state.setNodeDockLayout(nodeId, layout)
        else state.removeNode(nodeId)
        return
      }
      const layout = removePanelFromTree(node.dockLayout, panelId)
      if (layout && collectPanelIds(layout).length > 0) state.setNodeDockLayout(nodeId, layout)
      else state.removeNode(nodeId)
    },

    loadWorkspaceCanvas(
      nodes: Record<CanvasNodeId, CanvasNodeState>,
      viewportOffset: Point,
      zoomLevel: number,
    ) {
      storeApi.getState().loadWorkspaceCanvas(nodes, viewportOffset, zoomLevel)
    },

    clearAllNodes() {
      const s = storeApi.getState()
      for (const nodeId of Object.keys(s.nodes)) {
        s.removeNode(nodeId)
      }
    },

    focusPanelNode(panelId: string) {
      const state = storeApi.getState()
      const nodeId = state.nodeForPanel(panelId)
      if (nodeId) {
        state.focusAndCenter(nodeId)
      }
    },
  }
}
