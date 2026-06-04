// =============================================================================
// Workspace canvas access — resolves a workspace's primary ("center") canvas
// panel, its canvas store, and its CanvasOperations bridge.
//
// Canvas stores are keyed by PANEL id (getOrCreateCanvasStoreForPanel in
// canvasStore.ts), not by workspace id, because a workspace can host several
// canvas panels (nested canvases) and a canvas panel belongs to exactly one
// workspace. This module owns the canvas-panel-id -> CanvasOperations registry
// and the discovery of a workspace's primary canvas panel.
//
// It imports from appStore (to read workspace/panel state) and canvasStore (for
// the panel-keyed store factory). That one-directional appStore dependency is
// fine: the appStore <-> session cycle is broken separately via
// lib/workspace/deferredRestore.ts.
// =============================================================================

import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../../stores/canvasStore'
import type { CanvasOperations } from '../canvas/canvasBridge'
import type { DockLayoutNode } from '../../../shared/types'
import { ALL_ZONES } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { createCanvasOps } from '../canvas/canvasBridge'
import { getOrCreateCanvasStoreForPanel } from '../../stores/canvasStore'
import { getWorkspaceDockStore } from './dockRegistry'

// Registry for multi-canvas support — maps canvas panel IDs to their operations.
// Each canvas panel belongs to exactly one workspace, so resolving ops by panel
// id keeps workspaces isolated; there is no shared/global canvas any more.
const canvasOpsRegistry = new Map<string, CanvasOperations>()
let activeCanvasPanelId: string | null = null

// Cache of a workspace's primary canvas panel id. The dock-layout walk in
// computeWorkspaceCanvasPanelId is recomputed on every call otherwise; this
// turns the hot path (e.g. opening a panel, OS notifications) into an O(1)
// lookup.
//
// Invalidation rule (correctness MUST match the uncached dock-layout walk):
//   - When a workspace first caches an entry, we subscribe to its live dock
//     store and clear that workspace's entry on ANY dock-layout change. Dock
//     changes are the only thing that can move which canvas panel is "primary"
//     (the walk prefers the center zone, then other zones, then any panel), so
//     this re-walks lazily after every dock mutation — identical to no cache.
//   - Cleared for a workspace when that workspace is removed (appStore's
//     removeWorkspace cleanup calls invalidateWorkspaceCanvasCache).
//   - Cleared globally when any canvas panel is unregistered
//     (unregisterCanvasOps) — a belt-and-suspenders guard for canvas panels
//     that never had a live dock store subscription.
// As an extra safety net, a read only serves the cached id if it is still a
// canvas panel of the workspace (verified against appStore state).
const primaryCanvasByWorkspace = new Map<string, string>()
// Workspaces whose live dock store we've already subscribed to → the zustand
// unsubscribe fn for that subscription. Keyed (not a bare Set) so removal can
// actually tear the listener down: leaving it attached both grows this map
// unbounded and, if a workspace id is ever recycled, makes the new dock store
// skip its invalidation subscription (stale primary-canvas cache).
const dockUnsubscribeByWorkspace = new Map<string, () => void>()

export function registerCanvasOps(canvasPanelId: string, ops: CanvasOperations): void {
  canvasOpsRegistry.set(canvasPanelId, ops)
}

export function getCanvasOpsById(canvasPanelId: string): CanvasOperations | null {
  return canvasOpsRegistry.get(canvasPanelId) ?? null
}

export function ensureCanvasOpsForPanel(canvasPanelId: string): CanvasOperations {
  const existing = canvasOpsRegistry.get(canvasPanelId)
  if (existing) return existing
  const ops = createCanvasOps(getOrCreateCanvasStoreForPanel(canvasPanelId))
  canvasOpsRegistry.set(canvasPanelId, ops)
  return ops
}

export function unregisterCanvasOps(canvasPanelId: string): void {
  canvasOpsRegistry.delete(canvasPanelId)
  if (activeCanvasPanelId === canvasPanelId) activeCanvasPanelId = null
  // A canvas panel was removed: the primary-canvas resolution may now differ.
  primaryCanvasByWorkspace.clear()
}

export function setActiveCanvasPanelId(canvasPanelId: string): void {
  activeCanvasPanelId = canvasPanelId
}

/** Iterate all registered CanvasOperations (used to find a panel across canvases). */
export function allCanvasOps(): IterableIterator<CanvasOperations> {
  return canvasOpsRegistry.values()
}

/** Drop the cached primary-canvas entry for a workspace (on workspace removal),
 *  and tear down its dock-store invalidation subscription so the released store
 *  isn't retained and a recycled id re-subscribes to its fresh store. */
export function invalidateWorkspaceCanvasCache(workspaceId: string): void {
  primaryCanvasByWorkspace.delete(workspaceId)
  const unsubscribe = dockUnsubscribeByWorkspace.get(workspaceId)
  if (unsubscribe) {
    unsubscribe()
    dockUnsubscribeByWorkspace.delete(workspaceId)
  }
}

// Subscribe (once) to a workspace's live dock store so any dock-layout change
// invalidates the cached primary-canvas id. No-op if the live dock store
// doesn't exist yet — the next read after it's created will subscribe.
function ensureDockInvalidationSubscription(workspaceId: string): void {
  if (dockUnsubscribeByWorkspace.has(workspaceId)) return
  const dock = getWorkspaceDockStore(workspaceId)
  if (!dock) return
  const unsubscribe = dock.subscribe(() => {
    primaryCanvasByWorkspace.delete(workspaceId)
  })
  dockUnsubscribeByWorkspace.set(workspaceId, unsubscribe)
}

function collectDockPanelIds(node: DockLayoutNode | null | undefined, out: Set<string>): void {
  if (!node) return
  if (node.type === 'tabs') {
    for (const panelId of node.panelIds) out.add(panelId)
    return
  }
  for (const child of node.children) collectDockPanelIds(child, out)
}

function computeWorkspaceCanvasPanelId(workspaceId: string): string | null {
  const state = useAppStore.getState()
  const ws = state.workspaces.find((candidate) => candidate.id === workspaceId)
  if (!ws) return null

  // The workspace's own live dock store is authoritative once created; before
  // that (deferred / never-activated) fall back to the persisted snapshot.
  const liveDock = getWorkspaceDockStore(workspaceId)
  const dockSnapshot = liveDock ? liveDock.getState().getSnapshot() : ws.dockState

  if (dockSnapshot) {
    const panelIds = new Set<string>()
    collectDockPanelIds(dockSnapshot.zones.center.layout, panelIds)
    for (const panelId of panelIds) {
      if (ws.panels[panelId]?.type === 'canvas') return panelId
    }
    for (const zoneName of ALL_ZONES) {
      collectDockPanelIds(dockSnapshot.zones[zoneName].layout, panelIds)
    }
    for (const panelId of panelIds) {
      if (ws.panels[panelId]?.type === 'canvas') return panelId
    }
  }

  const fallback = Object.values(ws.panels).find((panel) => panel.type === 'canvas')
  return fallback?.id ?? null
}

export function getWorkspaceCanvasPanelId(workspaceId: string): string | null {
  const cached = primaryCanvasByWorkspace.get(workspaceId)
  if (cached) {
    // Only serve the cached id if it is still a canvas panel of this workspace,
    // so a cached result can never diverge from the uncached dock-layout walk.
    const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
    if (ws?.panels[cached]?.type === 'canvas') return cached
    primaryCanvasByWorkspace.delete(workspaceId)
  }
  const resolved = computeWorkspaceCanvasPanelId(workspaceId)
  if (resolved) {
    primaryCanvasByWorkspace.set(workspaceId, resolved)
    ensureDockInvalidationSubscription(workspaceId)
  }
  return resolved
}

export function getWorkspaceCanvasStore(workspaceId: string): StoreApi<CanvasStore> | null {
  const panelId = getWorkspaceCanvasPanelId(workspaceId)
  if (panelId) return ensureCanvasOpsForPanel(panelId).storeApi
  return null
}

/** CanvasOperations for a workspace's center canvas, or null if it has none yet. */
export function getWorkspaceCanvasOps(workspaceId: string): CanvasOperations | null {
  const canvasPanelId = getWorkspaceCanvasPanelId(workspaceId)
  return canvasPanelId ? ensureCanvasOpsForPanel(canvasPanelId) : null
}
