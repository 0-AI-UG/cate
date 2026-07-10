// =============================================================================
// Canvas Store — Zustand state for canvas nodes, viewport, and zoom.
// Ported from CanvasState.swift
//
// The action implementations are split into focused slices under ./canvas
// (each a `(set, get, ctx) => Pick<CanvasStoreActions, ...>` creator). This
// module owns the public surface: the store factory that composes the slices,
// the per-panel registry, and the render selectors.
// =============================================================================

import { create, type UseBoundStore } from 'zustand'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import type { StoreApi } from 'zustand'
import type { CanvasNodeId, CanvasNodeState } from '../../shared/types'
import { ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT } from '../../shared/types'
import { collectPanelIds } from '../../shared/collectPanelIds'
import { perfCount } from '../lib/perf/perfClient'
import { primitiveArrayEqual } from './selectorUtils'
import log from '../lib/logger'
import { sanitizeLoadedCanvasNodes, isValidPoint } from './canvas/sanitizeNodes'

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
        // Persisted geometry from `.cate` is untrusted: repair/drop invalid nodes
        // so one corrupt entry (e.g. a node missing `size`) can't crash the whole
        // canvas render. See sanitizeLoadedCanvasNodes.
        const { nodes: cleanNodes, repaired, dropped } = sanitizeLoadedCanvasNodes(
          nodes as Record<string, unknown>,
        )
        if (repaired.length || dropped.length) {
          log.warn(
            '[canvas] restored with invalid node geometry from .cate — repaired %d, dropped %d (repaired: %o, dropped: %o)',
            repaired.length,
            dropped.length,
            repaired,
            dropped,
          )
        }

        // Compute next counters from loaded data
        const nodeList = Object.values(cleanNodes)
        const maxZOrder = nodeList.reduce((max, n) => Math.max(max, n.zOrder), -1)
        const maxCreationIndex = nodeList.reduce((max, n) => Math.max(max, n.creationIndex), -1)

        // Ensure all loaded nodes have animationState: 'idle' so they don't animate on restore
        const idleNodes: Record<string, CanvasNodeState> = {}
        for (const [id, node] of Object.entries(cleanNodes)) {
          idleNodes[id] = { ...node, animationState: 'idle' }
        }

        set({
          nodes: idleNodes,
          viewportOffset: isValidPoint(viewportOffset) ? viewportOffset : { x: 0, y: 0 },
          zoomLevel: Number.isFinite(zoomLevel)
            ? Math.min(Math.max(zoomLevel, ZOOM_MIN), ZOOM_MAX)
            : ZOOM_DEFAULT,
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
// Per-panel store registry — delegated to the RendererSession, the single
// source of truth for panelId → store and nodeId → store lookups.
// -----------------------------------------------------------------------------

import { getDefaultSession } from '../drag/session'

export function getOrCreateCanvasStoreForPanel(
  panelId: string,
): StoreApi<CanvasStore> {
  const session = getDefaultSession()
  const existing = session.getCanvasStore(panelId)
  if (existing) return existing
  // Every canvas panel gets its own fresh store. A canvas panel belongs to one
  // workspace, so keying by panel id keeps workspaces fully isolated — no panel
  // ever shares state with another canvas.
  const store = createCanvasStore()
  session.registerCanvasStore(panelId, store)
  return store
}

/** Return the existing canvas store for a panel WITHOUT creating one. Lets
 *  read-only consumers (e.g. the cross-window panel report) inspect a canvas's
 *  nodes without instantiating empty stores for canvases that aren't mounted. */
export function peekCanvasStoreForPanel(
  panelId: string,
): StoreApi<CanvasStore> | undefined {
  return getDefaultSession().getCanvasStore(panelId)
}

export function releaseCanvasStoreForPanel(panelId: string): void {
  getDefaultSession().releaseCanvasStore(panelId)
}

/** Iterate every live CanvasStore (one per canvas panel currently mounted).
 *  Used by drag handlers to find the source canvas of a given node id. */
export function getAllCanvasStores(): StoreApi<CanvasStore>[] {
  return getDefaultSession().getCanvasStores()
}

// -----------------------------------------------------------------------------
// Granular selectors
// -----------------------------------------------------------------------------

/**
 * Returns a stable sorted array of node IDs ordered by zOrder.
 * Only triggers a re-render when nodes are added, removed, or z-order changes.
 */
export function useNodeIds(store: StoreApi<CanvasStore>): string[] {
  return useStoreWithEqualityFn(
    store,
    (s) => Object.values(s.nodes)
      .sort((a, b) => a.zOrder - b.zOrder)
      .map(n => n.id),
    primitiveArrayEqual,
  )
}

/**
 * Viewport-culled variant of useNodeIds. Only returns ids for nodes whose
 * bounding box intersects the visible canvas rect (expanded by a 1-screen
 * margin so panning doesn't thrash mount state at the edges). Focused, pinned,
 * and keep-mounted nodes are always included so they keep their live state.
 * `keepMountedPanelIds` is the set of panel ids that must stay mounted
 * off-screen — webview-backed extensions (see keepsMountedOffscreen) and
 * terminals the Cate Agent is driving (their pty boots on mount and the agent
 * reads their rendered screen). A node is exempt from the cull when it hosts any
 * of them. Omitting it skips that exemption entirely (pure geometric cull) — the
 * hook below requires it so a real caller can never accidentally re-enable
 * webview-destroying culling.
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

// Nodes that host a panel which must stay mounted off-screen (webview-backed
// extensions — see keepsMountedOffscreen). Geometric culling unmounts off-screen
// nodes, which destroys a <webview>'s guest process and resets all its in-page
// state; these nodes opt out so panning away and back preserves the session.
//
// Cached by the identity of `keepMountedPanelIds` — the set of panel ids whose
// type is keep-mounted, which the caller derives with an equality-checked
// selector (see CanvasPanel). That set is STABLE across pan/zoom/drag/resize
// frames (geometry updates swap `nodes` but never this set) and across pure
// panel-state churn (a title edit doesn't add/remove a keep-mounted panel).
//
// The keep-alive set is derived from which nodes CONTAIN a keep-mounted panel
// id, so the cache must invalidate on ANY change to node→panel membership — not
// just node add/remove. A node COUNT key missed the case where a keep-mounted
// panel tab is dragged between two EXISTING nodes (count unchanged, set identity
// unchanged), leaving a stale set that named the old node and let the cull
// destroy the panel's webview on the destination node. Instead we key on the
// membership STRUCTURE via a two-level cache:
//   1. `nodes` identity — stable across pan/zoom (those swap viewportOffset, not
//      `nodes`), so the hot culling path returns instantly with no walk.
//   2. a structural signature over each node's id + dockLayout object identity
//      (geometry moves reuse the same dockLayout reference; add/remove/move of a
//      panel mints a fresh dockLayout, so its identity is the membership signal).
//      A geometry drag swaps `nodes` but keeps every dockLayout reference, so the
//      signature matches and the recursive dock walk is still skipped.
// Only a real membership change bumps the signature and triggers the full walk.
const EMPTY_KEEP_ALIVE: ReadonlySet<string> = new Set()
const keepAliveCache = new WeakMap<
  object,
  { nodes: object; sig: string; ids: ReadonlySet<string> }
>()

// Stable numeric tag per distinct dockLayout object, so a node's membership state
// can be encoded into the signature string. A new dockLayout object (panel
// add/remove/move) gets a new tag; a preserved reference keeps its tag.
let dockLayoutTagCounter = 0
const dockLayoutTags = new WeakMap<object, number>()
function membershipSignature(nodes: Record<CanvasNodeId, CanvasNodeState>): string {
  let sig = ''
  for (const n of Object.values(nodes)) {
    let tag = dockLayoutTags.get(n.dockLayout)
    if (tag === undefined) {
      tag = ++dockLayoutTagCounter
      dockLayoutTags.set(n.dockLayout, tag)
    }
    sig += `${n.id}=d${tag};`
  }
  return sig
}

function keepAliveNodeIds(
  nodes: Record<CanvasNodeId, CanvasNodeState>,
  keepMountedPanelIds: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  if (!keepMountedPanelIds || keepMountedPanelIds.size === 0) return EMPTY_KEEP_ALIVE
  const cached = keepAliveCache.get(keepMountedPanelIds)
  // Fast path: same `nodes` object (pan/zoom/focus churn never mutates it).
  if (cached && cached.nodes === nodes) return cached.ids
  const sig = membershipSignature(nodes)
  // Medium path: `nodes` changed (e.g. a geometry drag) but no node's dockLayout
  // membership did — reuse the set, refresh the nodes ref, skip the dock walk.
  if (cached && cached.sig === sig) {
    keepAliveCache.set(keepMountedPanelIds, { nodes, sig, ids: cached.ids })
    return cached.ids
  }
  perfCount('canvasKeepAliveWalk')
  const ids = new Set<string>()
  for (const n of Object.values(nodes)) {
    const panelIds = collectPanelIds(n.dockLayout)
    if (panelIds.some((pid) => keepMountedPanelIds.has(pid))) ids.add(n.id)
  }
  keepAliveCache.set(keepMountedPanelIds, { nodes, sig, ids })
  return ids
}

/** Exported for unit testing: the raw keep-alive set builder (memoized). */
export { keepAliveNodeIds as __keepAliveNodeIdsForTest }

/** Pure core of {@link useVisibleNodeIds}. Returns the z-ordered ids of nodes
 *  that should be mounted: those intersecting the margin-expanded viewport, plus
 *  the always-mounted exemptions (focused, pinned, keep-mounted webview nodes).
 *  Exported for unit testing. */
export function selectVisibleNodeIds(
  s: Pick<
    CanvasStore,
    'nodes' | 'viewportOffset' | 'zoomLevel' | 'containerSize' | 'selection' | 'selectionActive'
  >,
  keepMountedPanelIds?: ReadonlySet<string>,
): string[] {
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

  const keepAlive = keepAliveNodeIds(nodes, keepMountedPanelIds)

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
    if (n.id === focusedNodeId || n.isPinned || keepAlive.has(n.id)) {
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
}

export function useVisibleNodeIds(
  store: StoreApi<CanvasStore>,
  keepMountedPanelIds: ReadonlySet<string>,
): string[] {
  return useStoreWithEqualityFn(
    store,
    (s) => selectVisibleNodeIds(s, keepMountedPanelIds),
    primitiveArrayEqual,
  )
}
