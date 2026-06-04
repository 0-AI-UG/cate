// =============================================================================
// Per-workspace dock-store registry — gives each workspace its own dock store
// instance so layout state can never bleed between workspaces. The main window
// reads the *active* workspace's store via DockStoreProvider; switching swaps
// which store the shell reads (and remounts the subtree) rather than copying
// state into a shared singleton.
//
// Canvas stores are not registered here: they are already isolated per
// canvas-panel-id by getOrCreateCanvasStoreForPanel (canvasStore.ts), and a
// canvas panel belongs to exactly one workspace. Resolve a workspace's canvas
// store via getWorkspaceCanvasStore (lib/workspace/canvasAccess.ts).
// =============================================================================

import type { StoreApi } from 'zustand'
import { createDockStore } from '../../stores/dockStore'
import type { DockStore } from '../../stores/dockStore'

const dockStoresByWorkspace = new Map<string, StoreApi<DockStore>>()

/** The workspace's dock store, creating an empty one on first access. */
export function getOrCreateWorkspaceDockStore(workspaceId: string): StoreApi<DockStore> {
  const existing = dockStoresByWorkspace.get(workspaceId)
  if (existing) return existing
  const store = createDockStore()
  dockStoresByWorkspace.set(workspaceId, store)
  return store
}

/** The workspace's dock store, or undefined if one hasn't been created yet. */
export function getWorkspaceDockStore(workspaceId: string): StoreApi<DockStore> | undefined {
  return dockStoresByWorkspace.get(workspaceId)
}

/** Drop a workspace's dock store (on workspace removal). */
export function releaseWorkspaceDockStore(workspaceId: string): void {
  dockStoresByWorkspace.delete(workspaceId)
}
