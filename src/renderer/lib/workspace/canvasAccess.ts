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
  DockZonePosition,
  WindowDockState,
  CanvasLayoutSnapshot,
} from '../../../shared/types'
import type { PanelPlacement } from '../../stores/appStore'
import { ALL_ZONES, ZOOM_DEFAULT } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { createCanvasOps } from '../canvas/canvasBridge'
import { getOrCreateCanvasStoreForPanel, peekCanvasStoreForPanel } from '../../stores/canvasStore'
import { getWorkspaceDockStore } from './dockRegistry'
import { getActivePanelId } from '../activePanel'
import { getLiveNodeDockLayout } from '../../panels/nodeDockRegistry'
import { collectPanelIds } from '../../../shared/collectPanelIds'

export function getCanvasOpsById(canvasPanelId: string): CanvasOperations | null {
  const store = peekCanvasStoreForPanel(canvasPanelId)
  return store ? createCanvasOps(store) : null
}

export function ensureCanvasOpsForPanel(canvasPanelId: string): CanvasOperations {
  return createCanvasOps(getOrCreateCanvasStoreForPanel(canvasPanelId))
}

/** The canvas panel that canvas-targeting actions (keyboard nav/pan/zoom, new
 *  node) should act on. Derived from the canonical activePanelId: if the active
 *  panel IS a live canvas (it has registered ops), that's it; otherwise (a
 *  docked/non-canvas panel is active, or nothing yet) fall back to the active
 *  workspace's primary canvas. The ops registry — not appStore — is the source
 *  of truth for "is this id a canvas", so this needs no panel-type lookup. */
export function getActiveCanvasPanelId(): string | null {
  const activeId = getActivePanelId()
  if (activeId && peekCanvasStoreForPanel(activeId)) return activeId
  return getWorkspaceCanvasPanelId(useAppStore.getState().selectedWorkspaceId)
}

/** CanvasOperations for the active canvas (see getActiveCanvasPanelId), or null
 *  if it isn't registered (e.g. a detached dock window with no canvas mounted).
 *  Lets call-time consumers (keyboard shortcuts) route to the canvas actually on
 *  screen rather than a mount-time context store. */
export function getActiveCanvasOps(): CanvasOperations | null {
  const canvasPanelId = getActiveCanvasPanelId()
  return canvasPanelId ? getCanvasOpsById(canvasPanelId) : null
}

/** Placement for a keyboard-created panel (Cmd+T / Cmd+N / …) based on the
 *  canonical active panel. A docked active panel → tab into its exact stack (so
 *  a split lands in the focused pane, not the zone's first stack). A canvas
 *  active panel → pinned to THAT canvas; none → undefined, the default
 *  (primary) canvas placement. */
export function placementForActivePanel(): PanelPlacement | undefined {
  const activeId = getActivePanelId()
  if (!activeId) return undefined
  // A canvas is itself a center-zone dock tab, so it HAS a dock location — but a
  // create while a canvas is active must land ON the canvas, not as a sibling
  // tab beside it. Canvas panels register ops, so the registry distinguishes
  // them. Pin to the active canvas explicitly: the unpinned default routes to
  // the workspace's PRIMARY canvas, which is the wrong (hidden) one whenever a
  // secondary canvas tab is active.
  if (peekCanvasStoreForPanel(activeId)) return { target: 'canvas', canvasPanelId: activeId }
  const workspaceId = useAppStore.getState().selectedWorkspaceId
  const location = getWorkspaceDockStore(workspaceId)?.getState().getPanelLocation(activeId)
  if (location?.type === 'dock') {
    return { target: 'dock', zone: location.zone, stackId: location.stackId }
  }
  return undefined
}

function computeWorkspaceCanvasPanelId(workspaceId: string): string | null {
  const state = useAppStore.getState()
  const ws = state.workspaces.find((candidate) => candidate.id === workspaceId)
  if (!ws) return null

  // The workspace's own live dock store is authoritative once created; before
  // that (deferred / never-activated) fall back to the persisted snapshot.
  const dockSnapshot = getWorkspaceDockSnapshot(workspaceId)

  if (dockSnapshot) {
    const centerPanelIds = collectPanelIds(dockSnapshot.zones.center.layout)
    for (const panelId of centerPanelIds) {
      if (ws.panels[panelId]?.type === 'canvas') return panelId
    }
    const remainingPanelIds = ALL_ZONES
      .filter((zoneName) => zoneName !== 'center')
      .flatMap((zoneName) => collectPanelIds(dockSnapshot.zones[zoneName].layout))
    for (const panelId of remainingPanelIds) {
      if (ws.panels[panelId]?.type === 'canvas') return panelId
    }
  }

  const fallback = Object.values(ws.panels).find((panel) => panel.type === 'canvas')
  return fallback?.id ?? null
}

export function getWorkspaceCanvasPanelId(workspaceId: string): string | null {
  return computeWorkspaceCanvasPanelId(workspaceId)
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

/** The canvas store the Cate Agent should act on for a pinned run: the pinned
 *  `canvasPanelId` if it's still a live canvas panel of the workspace, else the
 *  workspace's primary canvas. Pinning lets a running job keep acting on the canvas
 *  it started on even if the primary changes or the user navigates away. */
export function getAgentCanvasStore(workspaceId: string, canvasPanelId?: string): StoreApi<CanvasStore> | null {
  if (canvasPanelId) {
    const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
    if (ws?.panels[canvasPanelId]?.type === 'canvas') return ensureCanvasOpsForPanel(canvasPanelId).storeApi
  }
  return getWorkspaceCanvasStore(workspaceId)
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
  return getCanvasSnapshotForPanel(canvasPanelId)?.nodes[nodeId]?.dockLayout ?? null
}

/** Capture one canvas's lossless layout and complete child membership. */
export function captureCanvasPanel(canvasPanelId: string): CanvasLayoutSnapshot & { panelIds: string[] } {
  const state = getCanvasSnapshotForPanel(canvasPanelId) ?? {
    nodes: {},
    viewportOffset: { x: 0, y: 0 },
    zoomLevel: ZOOM_DEFAULT,
  }
  const nodes: Record<string, CanvasNodeState> = {}
  const panelIds = new Set<string>()
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    const dockLayout = getNodeDockLayout(canvasPanelId, nodeId) ?? node.dockLayout ?? null
    if (!dockLayout) continue
    nodes[nodeId] = { ...node, dockLayout }
    collectPanelIds(dockLayout, panelIds)
  }
  return {
    nodes,
    viewportOffset: { ...state.viewportOffset },
    zoomLevel: state.zoomLevel,
    panelIds: [...panelIds],
  }
}

/** Live dock snapshot for a workspace, or the persisted projection if the dock
 *  store has never been activated this session. */
export function getWorkspaceDockSnapshot(
  workspaceId: string,
): { zones: WindowDockState } | undefined {
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
    const nodes = getCanvasSnapshotForPanel(canvasPanelId)?.nodes ?? {}
    const containsPanel = Object.values(nodes).some((node) =>
      collectPanelIds(getNodeDockLayout(canvasPanelId, node.id)).includes(panelId),
    )
    if (containsPanel) {
      return { kind: 'canvas', canvasPanelId }
    }
  }
  return null
}
