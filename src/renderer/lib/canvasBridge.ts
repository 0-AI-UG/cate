// =============================================================================
// Canvas Bridge — implements CanvasOperations by delegating to a canvas store.
// Connects the appStore (which manages panel lifecycle) to the canvas store
// (which manages visual layout) without a direct import dependency.
// =============================================================================

import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../stores/canvasStore'
import type { CanvasOperations } from '../stores/appStore'
import type { PanelType, Point, CanvasNodeId, CanvasNodeState, CanvasRegion, CanvasAnnotation } from '../../shared/types'

export function createCanvasOps(storeApi: StoreApi<CanvasStore>): CanvasOperations {
  return {
    storeApi,

    addNodeAndFocus(panelId: string, panelType: PanelType, position?: Point) {
      const nodeId = storeApi.getState().addNode(panelId, panelType, position)
      storeApi.getState().focusAndCenter(nodeId)
    },

    removeNodeForPanel(panelId: string) {
      const state = storeApi.getState()
      const nodeId = state.nodeForPanel(panelId)
      if (nodeId) {
        state.removeNode(nodeId)
      }
    },

    loadWorkspaceCanvas(
      nodes: Record<CanvasNodeId, CanvasNodeState>,
      viewportOffset: Point,
      zoomLevel: number,
      focusedNodeId: CanvasNodeId | null,
      regions?: Record<string, CanvasRegion>,
      annotations?: Record<string, CanvasAnnotation>,
    ) {
      storeApi.getState().loadWorkspaceCanvas(nodes, viewportOffset, zoomLevel, focusedNodeId, regions, annotations)
    },

    syncCanvasSnapshot() {
      const s = storeApi.getState()
      return {
        nodes: { ...s.nodes },
        regions: { ...s.regions },
        annotations: { ...s.annotations },
        viewportOffset: { ...s.viewportOffset },
        zoomLevel: s.zoomLevel,
        focusedNodeId: s.focusedNodeId,
      }
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
