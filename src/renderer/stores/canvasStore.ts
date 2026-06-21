// =============================================================================
// Canvas Store — Zustand state for canvas nodes, viewport, and zoom.
// Ported from CanvasState.swift
//
// The action implementations are split into focused slices under ./canvas
// (each a `(set, get, ctx) => Pick<CanvasStoreActions, ...>` creator). This
// module owns the public surface: the store factory that composes the slices,
// the singleton + per-panel registry, and the render selectors.
// =============================================================================

import { create, type UseBoundStore } from 'zustand'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import type { StoreApi } from 'zustand'
import type { CanvasNodeId, CanvasNodeState } from '../../shared/types'
import { ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT } from '../../shared/types'
import { perfCount } from '../lib/perf/perfClient'
import { primitiveArrayEqual } from './selectorUtils'

import type { CanvasStore } from './canvas/storeTypes'
import { createCanvasStoreCtx } from './canvas/storeCtx'
import { createHistorySlice } from './canvas/historySlice'
import { createNodesSlice } from './canvas/nodesSlice'
import { createViewportSlice } from './canvas/viewportSlice'
import { createPlacementSlice } from './canvas/placementSlice'
import { createNavigationSlice } from './canvas/navigationSlice'
import { createSelectionSlice } from './canvas/selectionSlice'
import { createArrangeSlice } from './canvas/arrangeSlice'
import { focusedNodeId as focusedNodeIdOf } from './canvas/selectionModel'

// Re-export the store types so existing importers (`from '.../canvasStore'`)
// keep working unchanged.
export type {
  CanvasStore,
  CanvasStoreState,
  CanvasStoreActions,
  CanvasHistoryEntry,
  PendingPlacement,
} from './canvas/storeTypes'

// -----------------------------------------------------------------------------
// Store factory — creates independent canvas store instances
// -----------------------------------------------------------------------------

export function createCanvasStore(): UseBoundStore<StoreApi<CanvasStore>> {
  return create<CanvasStore>((set, get) => {
    // Per-instance non-reactive bookkeeping (rAF handles, pointer position).
    const ctx = createCanvasStoreCtx()

    return {
      // --- State ---
      nodes: {},
      viewportOffset: { x: 0, y: 0 },
      zoomLevel: ZOOM_DEFAULT,
      selection: [],
      selectionActive: false,
      focusEpoch: 0,
      nodeActiveWorktreeId: {},
      nextZOrder: 0,
      nextCreationIndex: 0,
      containerSize: { width: 0, height: 0 },
      snapGuides: { lines: [] },
      suppressAutoFocus: false,
      history: [],
      future: [],
      pendingPlacement: null,

      // --- Actions (composed from focused slices) ---
      ...createHistorySlice(set, get),
      ...createNodesSlice(set, get),
      ...createViewportSlice(set, get, ctx),
      ...createPlacementSlice(set, get, ctx),
      ...createNavigationSlice(set, get, ctx),
      ...createSelectionSlice(set, get),
      ...createArrangeSlice(set, get),

      // --- Lifecycle / bulk reset (counterpart to the initial state above) ---
      loadWorkspaceCanvas(nodes, viewportOffset, zoomLevel) {
        // Compute next counters from loaded data
        const nodeList = Object.values(nodes)
        const maxZOrder = nodeList.reduce((max, n) => Math.max(max, n.zOrder), -1)
        const maxCreationIndex = nodeList.reduce((max, n) => Math.max(max, n.creationIndex), -1)

        // Ensure all loaded nodes have animationState: 'idle' so they don't animate on restore
        const idleNodes: Record<string, CanvasNodeState> = {}
        for (const [id, node] of Object.entries(nodes)) {
          idleNodes[id] = { ...node, animationState: 'idle' }
        }

        set({
          nodes: idleNodes,
          viewportOffset,
          zoomLevel: Math.min(Math.max(zoomLevel, ZOOM_MIN), ZOOM_MAX),
          selection: [],
          selectionActive: false,
          nextZOrder: maxZOrder + 1,
          nextCreationIndex: maxCreationIndex + 1,
          history: [],
          future: [],
          pendingPlacement: null,
        })
      },
    }
  })
}

// -----------------------------------------------------------------------------
// Default singleton — backward-compatible during migration
// -----------------------------------------------------------------------------

export const useCanvasStore = createCanvasStore()

// -----------------------------------------------------------------------------
// Per-panel store registry — registration is delegated to the DragSession's
// canvasStores map. The session is the single source of truth for both
// panelId → store and nodeId → store lookups (the latter via a reverse index
// maintained by a store subscription). The local map below is kept for the
// returned `UseBoundStore` reference identity — the session stores a
// `StoreApi`, but consumers of this module hold `UseBoundStore` (`store(...)`).
// -----------------------------------------------------------------------------

import { getDefaultSession } from '../drag/session'

const canvasBoundStoresByPanelId = new Map<string, UseBoundStore<StoreApi<CanvasStore>>>()

export function getOrCreateCanvasStoreForPanel(
  panelId: string,
): UseBoundStore<StoreApi<CanvasStore>> {
  const existing = canvasBoundStoresByPanelId.get(panelId)
  if (existing) return existing
  // Every canvas panel gets its own fresh store. A canvas panel belongs to one
  // workspace, so keying by panel id keeps workspaces fully isolated — no panel
  // ever inherits the legacy `useCanvasStore` singleton (which, being shared and
  // never cleared, used to leak one workspace's nodes into another).
  const store = createCanvasStore()
  canvasBoundStoresByPanelId.set(panelId, store)
  getDefaultSession().registerCanvasStore(panelId, store)
  return store
}

/** Return the existing canvas store for a panel WITHOUT creating one. Lets
 *  read-only consumers (e.g. the cross-window panel report) inspect a canvas's
 *  nodes without instantiating empty stores for canvases that aren't mounted. */
export function peekCanvasStoreForPanel(
  panelId: string,
): UseBoundStore<StoreApi<CanvasStore>> | undefined {
  return canvasBoundStoresByPanelId.get(panelId)
}

export function releaseCanvasStoreForPanel(panelId: string): void {
  const store = canvasBoundStoresByPanelId.get(panelId)
  canvasBoundStoresByPanelId.delete(panelId)
  if (store) {
    getDefaultSession().releaseCanvasStore(panelId, store)
  }
}

/** Iterate every live CanvasStore (one per canvas panel currently mounted).
 *  Used by drag handlers to find the source canvas of a given node id. */
export function getAllCanvasStores(): UseBoundStore<StoreApi<CanvasStore>>[] {
  return Array.from(canvasBoundStoresByPanelId.values())
}

// -----------------------------------------------------------------------------
// Granular selectors
// -----------------------------------------------------------------------------

/**
 * Returns a stable sorted array of node IDs ordered by zOrder.
 * Only triggers a re-render when nodes are added, removed, or z-order changes.
 */
export function useNodeIds(store?: UseBoundStore<StoreApi<CanvasStore>>): string[] {
  return useStoreWithEqualityFn(
    store ?? useCanvasStore,
    (s) => Object.values(s.nodes)
      .sort((a, b) => a.zOrder - b.zOrder)
      .map(n => n.id),
    primitiveArrayEqual,
  )
}

/**
 * Viewport-culled variant of useNodeIds. Only returns ids for nodes whose
 * bounding box intersects the visible canvas rect (expanded by a 1-screen
 * margin so panning doesn't thrash mount state at the edges). Focused and
 * pinned nodes are always included so they keep their live state.
 *
 * This is the primary lever for reducing memory/CPU when many terminals or
 * editors are open on a canvas — off-screen nodes don't mount at all.
 */
// z-order-sorted node list, cached by the `nodes` object identity. The cull
// selector below runs on EVERY store update — including every pan/zoom frame,
// where only viewportOffset/zoomLevel changed and `nodes` is the same object.
// Without this cache that path re-allocated Object.values() and re-sorted the
// whole node set 60×/s during a drag. zustand replaces `nodes` immutably on any
// real node change, so identity equality is a safe cache key; a WeakMap also
// keeps it correct across multiple per-panel canvas stores (and never leaks).
const sortedNodeCache = new WeakMap<object, CanvasNodeState[]>()
function sortedNodesByZOrder(nodes: Record<CanvasNodeId, CanvasNodeState>): CanvasNodeState[] {
  const cached = sortedNodeCache.get(nodes)
  if (cached) return cached
  perfCount('canvasCullSort')
  const sorted = Object.values(nodes).sort((a, b) => a.zOrder - b.zOrder)
  sortedNodeCache.set(nodes, sorted)
  return sorted
}

export function useVisibleNodeIds(store?: UseBoundStore<StoreApi<CanvasStore>>): string[] {
  return useStoreWithEqualityFn(
    store ?? useCanvasStore,
    (s) => {
      perfCount('canvasCullEval')
      const { nodes, viewportOffset, zoomLevel, containerSize } = s
      const focusedNodeId = focusedNodeIdOf(s)
      const z = zoomLevel
      const cw = containerSize.width
      const ch = containerSize.height

      const sorted = sortedNodesByZOrder(nodes)

      // Before the container size is known, render everything — prevents an
      // initial flash where no nodes appear while the ResizeObserver settles.
      if (cw === 0 || ch === 0 || z <= 0) {
        return sorted.map((n) => n.id)
      }

      // Visible canvas-space rect. worldTransform is scale(z) then
      // translate(offset/z), so a canvas point p maps to p*z + offset in view
      // space. Inverting: canvas = (view - offset) / z.
      const marginX = cw / z
      const marginY = ch / z
      const left = -viewportOffset.x / z - marginX
      const top = -viewportOffset.y / z - marginY
      const right = (cw - viewportOffset.x) / z + marginX
      const bottom = (ch - viewportOffset.y) / z + marginY

      const result: string[] = []
      for (const n of sorted) {
        if (n.id === focusedNodeId || n.isPinned) {
          result.push(n.id)
          continue
        }
        const nx = n.origin.x
        const ny = n.origin.y
        const nr = nx + n.size.width
        const nb = ny + n.size.height
        if (nr < left || nx > right || nb < top || ny > bottom) continue
        result.push(n.id)
      }
      return result
    },
    primitiveArrayEqual,
  )
}
