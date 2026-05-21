// =============================================================================
// nodeDockRegistry — per-canvas-node DockStore registry. Lives in its own
// module (no React, no Canvas imports) so the drag dispatcher can import the
// lookup helpers without pulling in the full CanvasPanel tree. CanvasPanel
// owns registration/cleanup; everyone else just reads.
//
// This file exists as the first concrete step toward the Phase 3 plan goal of
// passing identities explicitly via a session/context rather than module-level
// scans. The map itself is still global; the next refactor moves it onto the
// DragSession.
// =============================================================================

import type { StoreApi } from 'zustand'
import type { DockStore } from '../stores/dockStore'

const nodeStoreMap = new Map<string, StoreApi<DockStore>>()

const storeKey = (canvasPanelId: string, nodeId: string) =>
  `${canvasPanelId}:${nodeId}`

export function registerNodeDockStore(
  canvasPanelId: string,
  nodeId: string,
  store: StoreApi<DockStore>,
): void {
  nodeStoreMap.set(storeKey(canvasPanelId, nodeId), store)
}

export function unregisterNodeDockStore(
  canvasPanelId: string,
  nodeId: string,
): void {
  nodeStoreMap.delete(storeKey(canvasPanelId, nodeId))
}

export function getNodeDockStore(
  canvasPanelId: string,
  nodeId: string,
): StoreApi<DockStore> | undefined {
  return nodeStoreMap.get(storeKey(canvasPanelId, nodeId))
}

/** Find the per-node DockStore that owns a canvas node (by canvas-node id).
 *  Iterates the map because drag handlers don't know the owning canvasPanelId
 *  at the time of lookup — there's at most a handful of canvases, so the scan
 *  is cheap. */
export function findNodeDockStore(nodeId: string): StoreApi<DockStore> | null {
  for (const [key, store] of nodeStoreMap.entries()) {
    if (key.endsWith(`:${nodeId}`)) return store
  }
  return null
}

/** Reverse lookup — given a DockStore, return the canvas-node id it backs
 *  (or null if the store isn't a per-canvas-node mini-dock). Lets drop handlers
 *  recognise drags that originated inside a canvas node and treat them as a
 *  node move instead of an undock + add. */
export function findNodeIdForDockStore(store: StoreApi<DockStore>): string | null {
  for (const [key, s] of nodeStoreMap.entries()) {
    if (s === store) {
      const idx = key.indexOf(':')
      return idx >= 0 ? key.slice(idx + 1) : null
    }
  }
  return null
}
