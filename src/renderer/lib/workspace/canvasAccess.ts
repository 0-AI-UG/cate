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
import type {
  DockLayoutNode,
  CanvasNodeId,
  CanvasNodeState,
  Point,
  PanelLocation,
  DockZonePosition,
  WindowDockState,
} from '../../../shared/types'
import type { PanelPlacement } from '../../stores/appStore'
import { ALL_ZONES, ZOOM_DEFAULT } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { createCanvasOps } from '../canvas/canvasBridge'
import { getOrCreateCanvasStoreForPanel } from '../../stores/canvasStore'
import { getWorkspaceDockStore } from './dockRegistry'
import { getActivePanelId } from '../activePanel'
import { getLiveNodeDockLayout } from '../../panels/nodeDockRegistry'

// Registry for multi-canvas support — maps canvas panel IDs to their operations.
// Each canvas panel belongs to exactly one workspace, so resolving ops by panel
// id keeps workspaces isolated; there is no shared/global canvas any more.
const canvasOpsRegistry = new Map<string, CanvasOperations>()

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
  // A canvas panel was removed: the primary-canvas resolution may now differ.
  primaryCanvasByWorkspace.clear()
}

/** The canvas panel that canvas-targeting actions (keyboard nav/pan/zoom, new
 *  node) should act on. Derived from the canonical activePanelId: if the active
 *  panel IS a live canvas (it has registered ops), that's it; otherwise (a
 *  docked/non-canvas panel is active, or nothing yet) fall back to the active
 *  workspace's primary canvas. The ops registry — not appStore — is the source
 *  of truth for "is this id a canvas", so this needs no panel-type lookup. */
export function getActiveCanvasPanelId(): string | null {
  const activeId = getActivePanelId()
  if (activeId && canvasOpsRegistry.has(activeId)) return activeId
  return getWorkspaceCanvasPanelId(useAppStore.getState().selectedWorkspaceId)
}

/** CanvasOperations for the active canvas (see getActiveCanvasPanelId), or null
 *  if it isn't registered (e.g. a detached dock window with no canvas mounted).
 *  Lets call-time consumers (keyboard shortcuts) route to the canvas actually on
 *  screen rather than a mount-time context store. */
export function getActiveCanvasOps(): CanvasOperations | null {
  const canvasPanelId = getActiveCanvasPanelId()
  return canvasPanelId ? canvasOpsRegistry.get(canvasPanelId) ?? null : null
}

/** Placement for a keyboard-created panel (Cmd+T / Cmd+N / …) based on the
 *  canonical active panel. A docked active panel → tab into its exact stack (so
 *  a split lands in the focused pane, not the zone's first stack). A canvas
 *  active panel (or none) → undefined, the default canvas placement. */
export function placementForActivePanel(): PanelPlacement | undefined {
  const activeId = getActivePanelId()
  if (!activeId) return undefined
  // A canvas is itself a center-zone dock tab, so it HAS a dock location — but a
  // create while a canvas is active must land ON the canvas, not as a sibling
  // tab beside it. Canvas panels register ops, so the registry distinguishes
  // them; treat them as the default (canvas) placement.
  if (canvasOpsRegistry.has(activeId)) return undefined
  const workspaceId = useAppStore.getState().selectedWorkspaceId
  const location = getWorkspaceDockStore(workspaceId)?.getState().getPanelLocation(activeId)
  if (location?.type === 'dock') {
    return { target: 'dock', zone: location.zone, stackId: location.stackId }
  }
  return undefined
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
  const dockSnapshot = getWorkspaceDockSnapshot(workspaceId)

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

/** Every canvas-type panel id in a workspace (the primary + any secondaries).
 *  Used by per-canvas save/restore and the cold-start sidebar attribution. */
export function getWorkspaceCanvasPanelIds(workspaceId: string): string[] {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
  if (!ws) return []
  return Object.values(ws.panels)
    .filter((p) => p.type === 'canvas')
    .map((p) => p.id)
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

// -----------------------------------------------------------------------------
// Live-store snapshot resolvers (Fix 3) — the live per-canvas CanvasStore and
// per-workspace DockStore are the single in-memory source of truth. The
// persisted WorkspaceState.canvases and dockState fields are persistence-only
// projections. These resolvers read the live store when it is mounted, falling
// back to the persisted projection for a never-mounted (background / cold-start)
// workspace so save still round-trips.
// -----------------------------------------------------------------------------

export interface WorkspaceCanvasSnapshot {
  nodes: Record<CanvasNodeId, CanvasNodeState>
  zoomLevel: number
  viewportOffset: Point
}

/** Snapshot for a SPECIFIC canvas panel (multi-canvas support). Reads the LIVE
 *  per-panel CanvasStore when it's mounted; otherwise falls back to the persisted
 *  `ws.canvases[canvasPanelId]` projection.
 *
 *  As with getWorkspaceCanvasSnapshot, this only reads a LIVE store — it never
 *  creates one for an unmounted canvas, so a never-mounted secondary canvas can't
 *  serialize an empty `{}` over its saved state. */
export function getCanvasSnapshotForPanel(canvasPanelId: string): WorkspaceCanvasSnapshot | null {
  const liveOps = getCanvasOpsById(canvasPanelId)
  if (liveOps) {
    const s = liveOps.storeApi.getState()
    return {
      nodes: { ...s.nodes },
      zoomLevel: s.zoomLevel,
      viewportOffset: { ...s.viewportOffset },
    }
  }
  // Find the workspace that owns this canvas panel to read its persisted
  // projection. A canvas panel belongs to exactly one workspace.
  const ws = useAppStore
    .getState()
    .workspaces.find((w) => w.panels[canvasPanelId]?.type === 'canvas')
  if (!ws) return null

  // `canvases` is the single persisted projection for EVERY canvas (primary and
  // secondary alike) of a never-mounted workspace.
  const persisted = ws.canvases?.[canvasPanelId]
  if (persisted) {
    return {
      nodes: { ...persisted.canvasNodes },
      zoomLevel: persisted.zoomLevel,
      viewportOffset: { ...persisted.viewportOffset },
    }
  }
  return { nodes: {}, zoomLevel: ZOOM_DEFAULT, viewportOffset: { x: 0, y: 0 } }
}

/** Live canvas snapshot for a workspace's center (primary) canvas, or the
 *  persisted projection if the canvas has never been mounted this session.
 *  Implemented in terms of the per-canvas resolver. */
export function getWorkspaceCanvasSnapshot(workspaceId: string): WorkspaceCanvasSnapshot | null {
  const canvasPanelId = getWorkspaceCanvasPanelId(workspaceId)
  if (!canvasPanelId) {
    // No canvas panel at all — return an empty snapshot for a known workspace so
    // save round-trips, null for an unknown one.
    const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return null
    return { nodes: {}, zoomLevel: ZOOM_DEFAULT, viewportOffset: { x: 0, y: 0 } }
  }
  return getCanvasSnapshotForPanel(canvasPanelId)
}

/** Resolve a canvas node's center dock layout, preferring the LIVE per-node
 *  DockStore (the single runtime authority) and falling back to the persisted
 *  `node.dockLayout` projection when the node's store isn't mounted (e.g. a
 *  viewport-culled off-screen node, or a background workspace whose canvas was
 *  never mounted this session). Returns `null` when neither yields a layout. */
export function getNodeDockLayout(canvasPanelId: string, nodeId: string): DockLayoutNode | null {
  const live = getLiveNodeDockLayout(canvasPanelId, nodeId)
  if (live !== undefined) return live
  return getOrCreateCanvasStoreForPanel(canvasPanelId).getState().nodes[nodeId]?.dockLayout ?? null
}

/** Live dock snapshot for a workspace, or the persisted projection if the dock
 *  store has never been activated this session. */
export function getWorkspaceDockSnapshot(
  workspaceId: string,
): { zones: WindowDockState; locations: Record<string, PanelLocation> } | undefined {
  const liveDock = getWorkspaceDockStore(workspaceId)
  if (liveDock) return liveDock.getState().getSnapshot()
  const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
  return ws?.dockState
}

// -----------------------------------------------------------------------------
// Panel location facade — the ONE probe that answers "where does panel X live in
// workspace W?", joining the three stores (dock tree + every canvas of the
// workspace) behind a single fixed probe order. Lives here, the lowest module
// that already owns dock + canvas + appStore access, so both panelReveal
// (read/reveal) and appStore.closePanel (remove) consume the same probe instead
// of each re-deriving it with a subtly different order/scope.
// -----------------------------------------------------------------------------

export type ResolvedPanelLocation =
  | { kind: 'dock'; zone: DockZonePosition; stackId: string }
  | { kind: 'canvas'; canvasPanelId: string }

/**
 * Locate a panel within a workspace. Fixed probe order:
 *   1. the workspace dock store (live tree, derived location)
 *   2. any canvas panel of the workspace (nodeForPanel)
 * Returns null if the panel is not currently placed anywhere.
 */
export function resolvePanelLocation(
  workspaceId: string,
  panelId: string,
): ResolvedPanelLocation | null {
  const dock = getWorkspaceDockStore(workspaceId)?.getState()
  const dockLocation = dock?.getPanelLocation(panelId)
  if (dockLocation?.type === 'dock') {
    return { kind: 'dock', zone: dockLocation.zone, stackId: dockLocation.stackId }
  }

  // Scan every canvas panel in the workspace (a workspace may host several
  // canvases; the primary one is preferred but we check all).
  const primary = getWorkspaceCanvasPanelId(workspaceId)
  const candidateCanvasIds = new Set<string>()
  if (primary) candidateCanvasIds.add(primary)
  const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
  if (ws) {
    for (const p of Object.values(ws.panels)) {
      if (p.type === 'canvas') candidateCanvasIds.add(p.id)
    }
  }
  for (const canvasPanelId of candidateCanvasIds) {
    const ops = getCanvasOpsById(canvasPanelId) ?? ensureCanvasOpsForPanel(canvasPanelId)
    if (ops.storeApi.getState().nodeForPanel(panelId)) {
      return { kind: 'canvas', canvasPanelId }
    }
  }
  return null
}
