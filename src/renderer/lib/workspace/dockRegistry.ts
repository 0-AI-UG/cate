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
import { getDefaultSession } from '../../drag/session'

/** The workspace's dock store, creating an empty one on first access. */
export function getOrCreateWorkspaceDockStore(workspaceId: string): StoreApi<DockStore> {
  const session = getDefaultSession()
  const existing = session.getWorkspaceDockStore(workspaceId)
  if (existing) return existing
  const store = createDockStore()
  session.registerWorkspaceDockStore(workspaceId, store)
  return store
}

/** The workspace's dock store, or undefined if one hasn't been created yet. */
export function getWorkspaceDockStore(workspaceId: string): StoreApi<DockStore> | undefined {
  return getDefaultSession().getWorkspaceDockStore(workspaceId)
}

/** Adopt an externally-created dock store as the workspace's store. Detached dock
 *  windows create their own store (createDockStore) and register it here so the
 *  shared placement code (placePanel → getOrCreateWorkspaceDockStore) targets the
 *  store this window actually renders, letting newly-created panels land here. */
export function registerWorkspaceDockStore(workspaceId: string, store: StoreApi<DockStore>): void {
  getDefaultSession().registerWorkspaceDockStore(workspaceId, store)
}

/** Drop a workspace's dock store (on workspace removal). */
export function releaseWorkspaceDockStore(workspaceId: string): void {
  getDefaultSession().releaseWorkspaceDockStore(workspaceId)
}
