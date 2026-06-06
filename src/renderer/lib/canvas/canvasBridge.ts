// =============================================================================
// Canvas Bridge — implements CanvasOperations by delegating to a canvas store.
// Connects the appStore (which manages panel lifecycle) to the canvas store
// (which manages visual layout) without a direct import dependency.
// =============================================================================

import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../../stores/canvasStore'
import type { PanelType, Point, CanvasNodeId, CanvasNodeState, DockLayoutNode } from '../../../shared/types'
import { findNodeDockStore } from '../../panels/nodeDockRegistry'

// -----------------------------------------------------------------------------
// Canvas operations callback — the contract createCanvasOps implements, letting
// the appStore (panel lifecycle) drive a canvas store (visual layout) without a
// direct import dependency on canvasStore.
// -----------------------------------------------------------------------------

export interface CanvasOperations {
  addNodeAndFocus: (panelId: string, panelType: PanelType, position?: Point) => void
  /** Begin interactive ghost placement. Returns true if ghosts are shown (the
   *  caller must NOT also place the node). `onCancelled` rolls the panel back. */
  beginPlacement: (
    panelId: string,
    panelType: PanelType,
    onCancelled: (panelId: string) => void,
  ) => boolean
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

function countLayoutPanels(node: DockLayoutNode): number {
  if (node.type === 'tabs') return node.panelIds.length
  let total = 0
  for (const child of node.children) total += countLayoutPanels(child)
  return total
}

export function createCanvasOps(storeApi: StoreApi<CanvasStore>): CanvasOperations {
  return {
    storeApi,

    addNodeAndFocus(panelId: string, panelType: PanelType, position?: Point) {
      const nodeId = storeApi.getState().addNode(panelId, panelType, position)
      storeApi.getState().focusAndCenter(nodeId)
    },

    beginPlacement(
      panelId: string,
      panelType: PanelType,
      onCancelled: (panelId: string) => void,
    ) {
      return storeApi.getState().beginPlacement(panelId, panelType, onCancelled)
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
      const layout = liveStore
        ? liveStore.getState().zones.center.layout
        : node.dockLayout
      if (layout && countLayoutPanels(layout) > 0) return
      state.removeNode(nodeId)
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
