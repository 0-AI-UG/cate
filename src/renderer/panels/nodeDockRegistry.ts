// =============================================================================
// nodeDockRegistry — per-canvas-node DockStore registry. Lives in its own
// module (no React, no Canvas imports) so the drag dispatcher can import the
// lookup helpers without pulling in the full CanvasPanel tree. CanvasPanel
// owns registration/cleanup; everyone else just reads.
//
// Storage lives on RendererSession; this module is the dock-specific facade.
// =============================================================================

import type { StoreApi } from 'zustand'
import type { DockLayoutNode } from '../../shared/types'
import { activeDockPanelId } from '../../shared/collectPanelIds'
import type { DockStore } from '../stores/dockStore'
import { getDefaultSession } from '../drag/session'

export { activeDockPanelId as activeLeafPanelId } from '../../shared/collectPanelIds'

/** Walk a dock layout tree to the id of the currently-active leaf panel. For a
 *  tab stack that's the active tab (`panelIds[activeIndex]`, falling back to the
 *  first tab); for a split, recurse into the first child that yields a leaf.
 *  Returns null for an empty/missing tree. Shared by CanvasNode (worktree pill +
 *  node-focus active-panel write) and getNodeActivePanelId so the two can't
 *  drift. */
export function registerNodeDockStore(
  canvasPanelId: string,
  nodeId: string,
  store: StoreApi<DockStore>,
): void {
  getDefaultSession().registerNodeDockStore(canvasPanelId, nodeId, store)
}

export function unregisterNodeDockStore(
  canvasPanelId: string,
  nodeId: string,
): void {
  getDefaultSession().unregisterNodeDockStore(canvasPanelId, nodeId)
}

export function getNodeDockStore(
  canvasPanelId: string,
  nodeId: string,
): StoreApi<DockStore> | undefined {
  return getDefaultSession().getNodeDockStore(canvasPanelId, nodeId)
}

/** Find the per-node DockStore that owns a canvas node (by canvas-node id).
 *  Iterates the map because drag handlers don't know the owning canvasPanelId
 *  at the time of lookup — there's at most a handful of canvases, so the scan
 *  is cheap. */
export function findNodeDockStore(nodeId: string): StoreApi<DockStore> | null {
  return getDefaultSession().findNodeDockStore(nodeId)
}

/** The active leaf panel id inside a canvas node's per-node mini-dock — i.e.
 *  which panel actually has input focus when this node is focused (the active
 *  tab, not the node's seed panel). Reads the node's registered DockStore center
 *  layout. Returns null if the node has no store/layout/leaf. */
export function getNodeActivePanelId(canvasPanelId: string, nodeId: string): string | null {
  const store = getNodeDockStore(canvasPanelId, nodeId)
  if (!store) return null
  return activeDockPanelId(store.getState().zones.center.layout)
}

/** The LIVE center-zone dock layout for a canvas node, read straight from its
 *  registered per-node DockStore (the single runtime authority). Returns the
 *  layout when the node's store is mounted/registered, or `undefined` when it is
 *  not — distinct from `null`, which means "mounted but empty". Callers that need
 *  a persisted fallback should treat `undefined` as "ask the projection". */
export function getLiveNodeDockLayout(
  canvasPanelId: string,
  nodeId: string,
): DockLayoutNode | null | undefined {
  const store = getNodeDockStore(canvasPanelId, nodeId)
  if (!store) return undefined
  return store.getState().zones.center.layout
}

/** Reverse lookup — given a DockStore, return the canvas-node id it backs
 *  (or null if the store isn't a per-canvas-node mini-dock). Lets drop handlers
 *  recognise drags that originated inside a canvas node and treat them as a
 *  node move instead of an undock + add. */
export function findNodeIdForDockStore(store: StoreApi<DockStore>): string | null {
  return getDefaultSession().findNodeIdForDockStore(store)
}
