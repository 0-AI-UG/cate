// =============================================================================
// Canvas Store — Zustand state for canvas nodes, viewport, and zoom.
// Ported from CanvasState.swift
// =============================================================================

import { create, type UseBoundStore } from 'zustand'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import type { StoreApi } from 'zustand'
import type {
  CanvasNodeId,
  CanvasNodeState,
  CanvasRegion,
  DockLayoutNode,
  Point,
  Size,
  PanelType,
  Rect,
} from '../../shared/types'
import {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_DEFAULT,
  PANEL_DEFAULT_SIZES,
} from '../../shared/types'
import {
  autoLayoutAll as computeAutoLayoutAll,
  CANVAS_GRID_SIZE,
} from '../canvas/layoutEngine'
import { viewToCanvas as viewToCanvasCoords } from '../lib/coordinates'
import { REGION_FILL_COLORS } from '../../shared/colors'
import { perfCount } from '../lib/perf/perfClient'

// Under e2e the windows are hidden, which throttles rAF — the rAF-driven
// entering->idle node transition can stall, leaving nodes at scale(0.85) so
// boundingBox-based drag specs grab the wrong point. Create nodes already idle
// in e2e so their geometry is final immediately (no enter animation).
const IS_E2E = typeof window !== 'undefined' && window.electronAPI?.isE2E === true

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

/** One offered new-node size/shape (multiple aspect ratios per panel type). */
export interface PlacementSizeVariant {
  size: Size
  label: string
}

/** A recommended spot for a new node, surfaced as a numbered, clickable "ghost". */
export interface PlacementCandidate {
  /** Snapped canvas-space top-left origin for the new node. */
  point: Point
  /** The size the ghost (and resulting node) would have. */
  size: Size
  /** 0 = best; ascending. Mirrors array order / the on-screen number (rank+1). */
  rank: number
  /** True when the candidate rect intersects the current viewport. */
  onScreen: boolean
}

/** Interactive ghost placement awaiting a user-chosen spot. */
export interface PendingPlacement {
  panelId: string
  panelType: PanelType
  /** 3–5 recommended spots; candidates[0] is the best. User picks by click or number. */
  candidates: PlacementCandidate[]
  hoveredIndex: number | null
  /** Free "place anywhere" mode — armed by pressing F. While armed, the cursor
   *  shows a "Place here" ghost and a click drops there; otherwise the ghost is
   *  hidden and clicking empty canvas cancels. */
  freeArmed: boolean
  /** Escape hatch preview: where a free "click-anywhere" placement would land
   *  (only while `freeArmed`). */
  freeGhost: { point: Point; size: Size } | null
  /** Viewport before we zoomed out to show recommendations — restored on cancel/commit. */
  prevZoom: number
  prevOffset: Point
  /** Invoked if the placement is cancelled — rolls the orphan panel record back. */
  onCancelled?: (panelId: string) => void
}

export interface CanvasStoreState {
  nodes: Record<CanvasNodeId, CanvasNodeState>
  regions: Record<string, CanvasRegion>
  viewportOffset: Point
  zoomLevel: number
  focusedNodeId: CanvasNodeId | null
  /** Increments on every focus action — lets panels re-run focus side effects even when focusedNodeId doesn't change. */
  focusEpoch: number
  nextZOrder: number
  nextCreationIndex: number
  containerSize: Size
  snapGuides: {
    lines: Array<{
      axis: 'x' | 'y'
      position: number
      type: 'edge' | 'center'
    }>
  }
  selectedNodeIds: Set<string>
  selectedRegionIds: Set<string>
  /** Region currently being hovered as a drop target during a node drag. */
  dropTargetRegionId: string | null
  /** Undo history — snapshots of {nodes, regions}. */
  history: CanvasHistoryEntry[]
  /** Redo stack — populated when undo() is called. */
  future: CanvasHistoryEntry[]
  /** Interactive ghost placement in progress (null when idle). */
  pendingPlacement: PendingPlacement | null
}

export interface CanvasHistoryEntry {
  nodes: Record<CanvasNodeId, CanvasNodeState>
  regions: Record<string, CanvasRegion>
  focusedNodeId: CanvasNodeId | null
}

export interface CanvasStoreActions {
  // Zoom animation control
  cancelZoomAnimation: () => void

  // Mutations
  addNode: (
    panelId: string,
    panelType: PanelType,
    position?: Point,
    size?: Size,
  ) => CanvasNodeId
  removeNode: (id: CanvasNodeId) => void
  finalizeRemoveNode: (nodeId: CanvasNodeId) => void
  setNodeAnimationState: (nodeId: CanvasNodeId, state: 'entering' | 'exiting' | 'idle') => void
  moveNode: (id: CanvasNodeId, origin: Point) => void
  resizeNode: (id: CanvasNodeId, size: Size, origin?: Point) => void
  focusNode: (id: CanvasNodeId) => void
  unfocus: () => void
  toggleMaximize: (id: CanvasNodeId, viewportSize: Size) => void
  setZoom: (level: number) => void
  setViewportOffset: (offset: Point) => void
  setZoomAndOffset: (zoom: number, offset: Point) => void
  setContainerSize: (size: Size) => void
  zoomAroundCenter: (newZoom: number) => void
  animateZoomTo: (targetZoom: number) => void

  // Derived getters
  canvasToView: (point: Point) => Point
  viewToCanvas: (point: Point) => Point
  viewFrame: (nodeId: CanvasNodeId) => Rect | null
  nodeForPanel: (panelId: string) => CanvasNodeId | null
  sortedNodesByCreationOrder: () => CanvasNodeState[]
  nextNode: () => CanvasNodeId | null
  previousNode: () => CanvasNodeId | null

  // Focus and center viewport on a node
  focusAndCenter: (nodeId: CanvasNodeId) => void

  // Interactive ghost placement
  /** Record the latest canvas-space pointer position so recommendations can be
   *  anchored to where the mouse is hovering. Non-reactive (no re-render). */
  setPlacementPointer: (point: Point | null) => void
  /** Begin interactive ghost placement: compute 3–5 recommended spots, zoom out
   *  to reveal them, and render numbered ghosts. Returns true if ghosts are shown
   *  (caller must NOT also place the node). `onCancelled` rolls the panel back. */
  beginPlacement: (
    panelId: string,
    panelType: PanelType,
    onCancelled?: (panelId: string) => void,
  ) => boolean
  /** Commit the pending placement at the given candidate index; returns the new node id. */
  commitPlacement: (index: number) => CanvasNodeId | null
  /** Arm/disarm free "place anywhere" mode (press F). Disarming clears the ghost. */
  setFreeArmed: (armed: boolean) => void
  /** Escape hatch: preview a free placement centred on `point` (canvas-space),
   *  nudged to the nearest non-overlapping spot. No-op when idle. */
  updatePlacementCursor: (point: Point) => void
  /** Escape hatch: commit a free placement centred on `point` (click-anywhere). */
  commitFreePlacement: (point: Point) => CanvasNodeId | null
  /** Cancel the pending placement and roll back the orphan panel record. */
  cancelPlacement: () => void
  /** Highlight a candidate ghost (null clears the hover). */
  setPlacementHover: (index: number | null) => void

  // Move focus to the spatially-nearest node in a direction, centering it
  navigateDirection: (dir: 'up' | 'down' | 'left' | 'right') => void

  zoomToFit: () => void
  zoomToSelection: () => void

  // Z-order management
  moveToFront: (nodeId: CanvasNodeId) => void
  moveToBack: (nodeId: CanvasNodeId) => void

  togglePin: (id: CanvasNodeId) => void

  setSnapGuides: (guides: {
    lines: Array<{
      axis: 'x' | 'y'
      position: number
      type: 'edge' | 'center'
    }>
  }) => void
  clearSnapGuides: () => void

  autoLayout: () => void

  // Selection
  selectNodes: (ids: string[], additive?: boolean) => void
  selectRegions: (ids: string[], additive?: boolean) => void
  clearSelection: () => void
  selectAll: () => void
  toggleNodeSelection: (id: string) => void
  toggleRegionSelection: (id: string) => void
  deleteSelection: (includeRegionContents?: boolean) => void

  // Region management
  addRegion: (label: string, origin: Point, size: Size, color?: string) => string
  removeRegion: (id: string) => void
  moveRegion: (id: string, origin: Point) => void
  resizeRegion: (id: string, size: Size, origin?: Point) => void
  renameRegion: (id: string, label: string) => void
  updateRegionColor: (id: string, color: string) => void
  setRegionDefaultCwd: (id: string, defaultCwd: string | undefined) => void

  // Containment
  setNodeRegion: (nodeId: string, regionId: string | undefined) => void
  getNodesInRegion: (regionId: string) => CanvasNodeState[]
  groupSelectedIntoRegion: () => string | null
  groupSelectedHorizontal: () => string | null
  stackSelected: (axis: 'row' | 'column', gap?: number) => void
  tidyGridSelected: (gap?: number) => void
  dissolveRegion: (regionId: string) => void

  // Per-node dock layout — replaces split/stack actions. Each canvas node owns
  // a tree (rendered via the dock primitives) that lives here as serialised
  // state. The per-node DockStore in CanvasNodeWrapper writes back via this.
  setNodeDockLayout: (nodeId: CanvasNodeId, layout: DockLayoutNode | null) => void

  // Undo/redo history
  pushHistory: () => void
  undo: () => void
  redo: () => void
  clearHistory: () => void

  // Bulk reset (used when switching workspaces)
  loadWorkspaceCanvas: (
    nodes: Record<CanvasNodeId, CanvasNodeState>,
    viewportOffset: Point,
    zoomLevel: number,
    focusedNodeId: CanvasNodeId | null,
    regions?: Record<string, CanvasRegion>,
  ) => void
}

export type CanvasStore = CanvasStoreState & CanvasStoreActions

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID()
}

/**
 * Find a free position for a new node that does not overlap any existing node.
 * From the reference node (focused, else most recently created) search outward
 * in all four cardinal directions, jumping past obstacles along each ray, and
 * return the slot whose center is closest to the reference's center.
 */
function findFreePosition(
  nodes: Record<CanvasNodeId, CanvasNodeState>,
  focusedNodeId: CanvasNodeId | null,
  defaultSize: Size,
  preferred?: Point,
): Point {
  const nodeList = Object.values(nodes)
  if (nodeList.length === 0) {
    return preferred ?? { x: 100, y: 100 }
  }

  const gap = 40
  const grid = CANVAS_GRID_SIZE
  const snap = (v: number) => Math.round(v / grid) * grid

  const overlaps = (p: Point) => {
    const rect = { origin: p, size: defaultSize }
    return nodeList.find((n) =>
      rectsOverlap({ origin: n.origin, size: n.size }, rect),
    )
  }

  if (preferred) {
    const snapped = { x: snap(preferred.x), y: snap(preferred.y) }
    if (!overlaps(snapped)) return snapped
  }

  const reference =
    (focusedNodeId && nodes[focusedNodeId]) ||
    nodeList.reduce((a, b) => (b.creationIndex > a.creationIndex ? b : a))
  const ref = { origin: reference.origin, size: reference.size }

  const directions: Array<{ dx: -1 | 0 | 1; dy: -1 | 0 | 1 }> = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ]

  const slotInDirection = (dir: { dx: number; dy: number }): Point | null => {
    let p: Point
    if (dir.dx > 0) p = { x: ref.origin.x + ref.size.width + gap, y: ref.origin.y }
    else if (dir.dx < 0) p = { x: ref.origin.x - defaultSize.width - gap, y: ref.origin.y }
    else if (dir.dy > 0) p = { x: ref.origin.x, y: ref.origin.y + ref.size.height + gap }
    else p = { x: ref.origin.x, y: ref.origin.y - defaultSize.height - gap }

    for (let i = 0; i < 200; i++) {
      const obstacle = overlaps(p)
      if (!obstacle) return p
      if (dir.dx > 0) p = { x: obstacle.origin.x + obstacle.size.width + gap, y: p.y }
      else if (dir.dx < 0) p = { x: obstacle.origin.x - defaultSize.width - gap, y: p.y }
      else if (dir.dy > 0) p = { x: p.x, y: obstacle.origin.y + obstacle.size.height + gap }
      else p = { x: p.x, y: obstacle.origin.y - defaultSize.height - gap }
    }
    return null
  }

  const refCenter = {
    x: ref.origin.x + ref.size.width / 2,
    y: ref.origin.y + ref.size.height / 2,
  }
  let best: Point | null = null
  let bestDist = Infinity
  for (const dir of directions) {
    const slot = slotInDirection(dir)
    if (!slot) continue
    const cx = slot.x + defaultSize.width / 2
    const cy = slot.y + defaultSize.height / 2
    const dist = Math.hypot(cx - refCenter.x, cy - refCenter.y)
    if (dist < bestDist) {
      bestDist = dist
      best = slot
    }
  }

  if (best) return { x: snap(best.x), y: snap(best.y) }

  // Fallback: stack below everything, aligned with the reference.
  const maxBottom = nodeList.reduce(
    (acc, n) => Math.max(acc, n.origin.y + n.size.height),
    -Infinity,
  )
  return { x: snap(ref.origin.x), y: snap(maxBottom + gap) }
}

/**
 * Size/shape variants offered for a new panel — multiple aspect ratios so the
 * user can pick not just where but how big/what shape the node is. Derived from
 * the panel's default size and grid-snapped.
 */
export function placementSizeVariants(panelType: PanelType): PlacementSizeVariant[] {
  const base = PANEL_DEFAULT_SIZES[panelType]
  const g = CANVAS_GRID_SIZE
  const snap = (v: number) => Math.max(g, Math.round(v / g) * g)
  const mk = (w: number, h: number, label: string): PlacementSizeVariant => ({
    size: { width: snap(w), height: snap(h) },
    label,
  })
  return [
    mk(base.width, base.height, 'Standard'),
    mk(base.width * 1.5, base.height, 'Wide'),
    mk(base.width, base.height * 1.4, 'Tall'),
    mk(base.width * 1.3, base.height * 1.25, 'Large'),
  ]
}

/** Uniform gap (canvas px) between a new panel and its neighbours / other ghosts. */
const PLACEMENT_GAP = 40
/** Smallest a gap-fill recommendation may be (canvas px), and its aspect-ratio
 *  bounds (width / height) — a sub-standard hole only gets a recommendation if a
 *  panel within these limits fits it. */
const PLACEMENT_MIN_W = 280
const PLACEMENT_MIN_H = 180
const PLACEMENT_MAX_W = 1400
const PLACEMENT_MAX_H = 900
const PLACEMENT_MIN_AR = 0.6
const PLACEMENT_MAX_AR = 2.6

// --- Geometry helpers for context-aware recommendations ----------------------

/** Edge-to-edge distance between two rects (0 if they overlap or touch). */
function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.origin.x - (b.origin.x + b.size.width), b.origin.x - (a.origin.x + a.size.width))
  const dy = Math.max(0, a.origin.y - (b.origin.y + b.size.height), b.origin.y - (a.origin.y + a.size.height))
  return Math.hypot(dx, dy)
}

/** Area of the intersection of two rects. */
function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.max(0, Math.min(a.origin.x + a.size.width, b.origin.x + b.size.width) - Math.max(a.origin.x, b.origin.x))
  const h = Math.max(0, Math.min(a.origin.y + a.size.height, b.origin.y + b.size.height) - Math.max(a.origin.y, b.origin.y))
  return w * h
}

/** Distance from a point to a rect (0 if inside). */
function pointRectDistance(p: Point, r: Rect): number {
  const dx = Math.max(0, r.origin.x - p.x, p.x - (r.origin.x + r.size.width))
  const dy = Math.max(0, r.origin.y - p.y, p.y - (r.origin.y + r.size.height))
  return Math.hypot(dx, dy)
}

/** Group nodes into "islands" — connected components where consecutive nodes
 *  are within `threshold` canvas px (edge-to-edge) of each other (union-find). */
function clusterNodes(nodeList: CanvasNodeState[], threshold: number): CanvasNodeState[][] {
  const n = nodeList.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] }
    return i
  }
  for (let i = 0; i < n; i++) {
    const ri: Rect = { origin: nodeList[i].origin, size: nodeList[i].size }
    for (let j = i + 1; j < n; j++) {
      const rj: Rect = { origin: nodeList[j].origin, size: nodeList[j].size }
      if (rectGap(ri, rj) <= threshold) parent[find(i)] = find(j)
    }
  }
  const groups = new Map<number, CanvasNodeState[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const g = groups.get(root) ?? []
    g.push(nodeList[i])
    groups.set(root, g)
  }
  return [...groups.values()]
}

/** Bounding rect of a set of nodes. */
function boundsOf(nodes: CanvasNodeState[]): Rect {
  const minX = Math.min(...nodes.map((n) => n.origin.x))
  const minY = Math.min(...nodes.map((n) => n.origin.y))
  const maxX = Math.max(...nodes.map((n) => n.origin.x + n.size.width))
  const maxY = Math.max(...nodes.map((n) => n.origin.y + n.size.height))
  return { origin: { x: minX, y: minY }, size: { width: maxX - minX, height: maxY - minY } }
}

/** Grow a rect by `m` on every side. */
function inflateRect(r: Rect, m: number): Rect {
  return {
    origin: { x: r.origin.x - m, y: r.origin.y - m },
    size: { width: r.size.width + m * 2, height: r.size.height + m * 2 },
  }
}

/** Shrink (w,h) to fall within [minAR, maxAR] aspect ratio, keeping it inside. */
function clampAspect(w: number, h: number, minAR: number, maxAR: number): Size {
  const ar = w / h
  if (ar > maxAR) w = h * maxAR
  else if (ar < minAR) h = w / minAR
  return { width: w, height: h }
}

/** Grid-snap + clamp a size to the placement min/max + aspect-ratio bounds. */
function clampPlacementSize(w: number, h: number, grid: number): Size {
  const snap = (v: number) => Math.max(grid, Math.round(v / grid) * grid)
  const s = clampAspect(
    Math.min(Math.max(w, PLACEMENT_MIN_W), PLACEMENT_MAX_W),
    Math.min(Math.max(h, PLACEMENT_MIN_H), PLACEMENT_MAX_H),
    PLACEMENT_MIN_AR, PLACEMENT_MAX_AR,
  )
  return { width: snap(s.width), height: snap(s.height) }
}

/**
 * Find gaps BETWEEN nodes in a cluster and size a panel to FILL each, within the
 * placement bounds. A horizontal gap (between two side-by-side nodes) and a
 * vertical gap each yield a candidate sized to the gap (clamped to min/max + AR)
 * and centred in it — so both narrower-than-reference and wider-than-reference
 * gaps get an individually-sized recommendation. A candidate is emitted only
 * when its size differs meaningfully from the reference `ref` (otherwise an
 * ordinary reference-sized spot already covers the gap) and it is actually free.
 */
function gapFillCandidates(
  cluster: CanvasNodeState[],
  ref: Size,
  gap: number,
  grid: number,
  allNodeRects: Rect[],
): Rect[] {
  const out: Rect[] = []
  const fits = (rect: Rect): boolean =>
    rect.size.width > 0 && rect.size.height > 0 &&
    !allNodeRects.some((r) => rectsOverlap(inflateRect(rect, gap - 1), r))
  const rects = cluster.map((n) => ({ origin: n.origin, size: n.size }))
  const consider = (availW: number, availH: number, ox0: number, oy0: number) => {
    if (availW < PLACEMENT_MIN_W || availH < PLACEMENT_MIN_H) return
    const s = clampPlacementSize(availW, availH, grid)
    // Skip gaps a reference-sized panel already fits cleanly.
    if (Math.abs(s.width - ref.width) <= 2 * gap && Math.abs(s.height - ref.height) <= 2 * gap) return
    const rect: Rect = {
      origin: { x: ox0 + (availW - s.width) / 2, y: oy0 + (availH - s.height) / 2 },
      size: s,
    }
    if (fits(rect)) out.push(rect)
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = 0; j < rects.length; j++) {
      if (i === j) continue
      const A = rects[i]
      const B = rects[j]
      const aR = A.origin.x + A.size.width
      const aB = A.origin.y + A.size.height
      const bR = B.origin.x + B.size.width
      const bB = B.origin.y + B.size.height
      // Horizontal gap: B to the right of A, sharing a vertical band.
      const hTop = Math.max(A.origin.y, B.origin.y)
      const hBot = Math.min(aB, bB)
      consider(B.origin.x - aR - 2 * gap, hBot - hTop - 2 * gap, aR + gap, hTop + gap)
      // Vertical gap: B below A, sharing a horizontal band.
      const vLeft = Math.max(A.origin.x, B.origin.x)
      const vRight = Math.min(aR, bR)
      consider(vRight - vLeft - 2 * gap, B.origin.y - aB - 2 * gap, vLeft + gap, aB + gap)
    }
  }
  return out
}

/** Median width/height of a set of nodes — the cluster's "typical" panel size. */
function medianNodeSize(nodes: CanvasNodeState[]): Size {
  const ws = nodes.map((n) => n.size.width).sort((a, b) => a - b)
  const hs = nodes.map((n) => n.size.height).sort((a, b) => a - b)
  const mid = (arr: number[]) => arr[Math.floor(arr.length / 2)]
  return { width: mid(ws), height: mid(hs) }
}

/**
 * Compute context-aware recommended spots for the interactive "ghost" picker.
 *
 * The recommendation set depends on what the user is focused on:
 *  - **Active node** (the focused node when it's on screen, or a single node that
 *    dominates the viewport when zoomed in): recommend tightly AROUND that node —
 *    its four directions, hopping just past an immediate neighbour if an edge is
 *    blocked. The active node is the centre of the recommendations.
 *  - **No active node, but the viewport is blank** (panned to empty space):
 *    recommend centred on where the user is looking.
 *  - **No active node, nodes on screen**: group nodes into islands, pick the
 *    island nearest the anchor, and recommend around its perimeter (more spots).
 *  - **Empty canvas**: a few spots centred on the anchor.
 *
 * Slots always keep a uniform gap to every node and to other ghosts (no touching,
 * no oversized gaps), are deduped + grid-snapped, ranked by proximity to the
 * relevant anchor (on-screen first), and there is always ≥1 result.
 *
 * @param anchor canvas-space point (mouse pos when available) used to pick the
 *               nearest island and rank spots; falls back to the viewport centre.
 */
export function recommendPlacements(
  nodes: Record<CanvasNodeId, CanvasNodeState>,
  focusedNodeId: CanvasNodeId | null,
  panelType: PanelType,
  viewport: { offset: Point; zoom: number; containerSize: Size },
  anchor: Point | null,
  max = 6,
): PlacementCandidate[] {
  const grid = CANVAS_GRID_SIZE
  const snap = (v: number) => Math.round(v / grid) * grid
  const snapPt = (p: Point): Point => ({ x: snap(p.x), y: snap(p.y) })
  const gap = PLACEMENT_GAP
  const baseSize = PANEL_DEFAULT_SIZES[panelType]
  // Adaptive recommendation size — set per context below so new panels match the
  // panels they sit beside (and never become absurdly small/large).
  let size = baseSize

  const { offset, zoom, containerSize } = viewport
  const hasViewport = containerSize.width > 0 && containerSize.height > 0
  const viewTopLeft = viewToCanvasCoords({ x: 0, y: 0 }, zoom, offset)
  const viewBottomRight = viewToCanvasCoords(
    { x: containerSize.width, y: containerSize.height },
    zoom,
    offset,
  )
  const viewRect: Rect = {
    origin: viewTopLeft,
    size: { width: viewBottomRight.x - viewTopLeft.x, height: viewBottomRight.y - viewTopLeft.y },
  }
  const viewCenter = {
    x: viewTopLeft.x + viewRect.size.width / 2,
    y: viewTopLeft.y + viewRect.size.height / 2,
  }
  const nodeOnScreen = (n: CanvasNodeState): boolean =>
    hasViewport && rectsOverlap({ origin: n.origin, size: n.size }, viewRect)

  const nodeList = Object.values(nodes)
  const nodeRects: Rect[] = nodeList.map((n) => ({ origin: n.origin, size: n.size }))
  const margin = gap - 1
  const clearRect = (rect: Rect, rects: Rect[]): boolean =>
    !rects.some((r) => rectsOverlap(inflateRect(rect, margin), r))
  const onScreenRect = (rect: Rect): boolean => hasViewport && rectsOverlap(rect, viewRect)
  const centerOf = (n: CanvasNodeState): Point => ({
    x: n.origin.x + n.size.width / 2,
    y: n.origin.y + n.size.height / 2,
  })
  const anchorPt: Point =
    anchor ?? (hasViewport ? viewCenter : { x: 100 + baseSize.width / 2, y: 100 + baseSize.height / 2 })

  // --- Determine context (mode + relevant node) ----------------------------
  let mode: 'empty' | 'active' | 'blank' | 'island' = 'empty'
  let activeNode: CanvasNodeState | null = null
  let target: CanvasNodeState[] | null = null
  if (nodeList.length > 0) {
    const focused = (focusedNodeId && nodes[focusedNodeId]) || null
    activeNode = focused && nodeOnScreen(focused) ? focused : null
    if (!activeNode && hasViewport) {
      const vpArea = viewRect.size.width * viewRect.size.height
      let best: CanvasNodeState | null = null
      let bestFrac = 0
      for (const n of nodeList) {
        const frac = intersectionArea({ origin: n.origin, size: n.size }, viewRect) / vpArea
        if (frac > bestFrac) { bestFrac = frac; best = n }
      }
      if (bestFrac >= 0.5) activeNode = best
    }
    const clusters = clusterNodes(nodeList, Math.max(baseSize.width, baseSize.height))
    if (activeNode) {
      const an = activeNode
      mode = 'active'
      target = clusters.find((c) => c.some((n) => n.id === an.id)) ?? [an]
    } else if (nodeList.some(nodeOnScreen)) {
      mode = 'island'
      target = clusters[0]
      let bestDist = Infinity
      for (const c of clusters) {
        const d = pointRectDistance(anchorPt, boundsOf(c))
        if (d < bestDist) { bestDist = d; target = c }
      }
    } else {
      mode = 'blank'
    }
  }

  // --- Adaptive size: match the panels we're sitting beside ----------------
  if (mode === 'active' && activeNode) size = clampPlacementSize(activeNode.size.width, activeNode.size.height, grid)
  else if (mode === 'island' && target) {
    const m = medianNodeSize(target)
    size = clampPlacementSize(m.width, m.height, grid)
  }

  // Spots aligned to a node's edges (right/left/below/above), grouped together.
  const edgeSlots = (n: CanvasNodeState): Point[] => [
    { x: n.origin.x + n.size.width + gap, y: n.origin.y },
    { x: n.origin.x - size.width - gap, y: n.origin.y },
    { x: n.origin.x, y: n.origin.y + n.size.height + gap },
    { x: n.origin.x, y: n.origin.y - size.height - gap },
  ]

  // --- Gather candidate rects (reference-sized spots + gap-fill) ------------
  type Cand = { point: Point; size: Size; custom: boolean }
  const cands: Cand[] = []
  const pushStd = (p: Point) => cands.push({ point: snapPt(p), size, custom: false })
  let rankAnchor = anchorPt
  let cap = max
  const centreSpots = () => {
    const c = { x: anchorPt.x - size.width / 2, y: anchorPt.y - size.height / 2 }
    pushStd(c); pushStd({ x: c.x + size.width + gap, y: c.y }); pushStd({ x: c.x, y: c.y + size.height + gap })
    cap = Math.min(max, 3)
  }

  if (mode === 'empty' || mode === 'blank') {
    centreSpots()
  } else if (mode === 'active' && activeNode) {
    // ACTIVE NODE → a single CONTIGUOUS group right next to it. Walk a lattice
    // anchored on the active node (one panel + gap per cell) breadth-first,
    // accepting only free cells and never crossing an occupied one.
    const an = activeNode
    rankAnchor = centerOf(an)
    const pitchX = size.width + gap
    const pitchY = size.height + gap
    const cellX = (i: number): number =>
      i === 0 ? an.origin.x
        : i > 0 ? an.origin.x + an.size.width + gap + (i - 1) * pitchX
          : an.origin.x - (size.width + gap) - (-i - 1) * pitchX
    const cellY = (j: number): number =>
      j === 0 ? an.origin.y
        : j > 0 ? an.origin.y + an.size.height + gap + (j - 1) * pitchY
          : an.origin.y - (size.height + gap) - (-j - 1) * pitchY
    const cell = (i: number, j: number): Point => snapPt({ x: cellX(i), y: cellY(j) })
    const visited = new Set<string>(['0,0'])
    const queue: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    let placed = 0
    while (queue.length > 0 && placed < 4) {
      queue.sort((a, b) =>
        (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1])) ||
        (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]),
      )
      const [i, j] = queue.shift()!
      const key = `${i},${j}`
      if (visited.has(key)) continue
      visited.add(key)
      const p = cell(i, j)
      if (!clearRect({ origin: p, size }, nodeRects)) continue
      pushStd(p); placed++
      queue.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1])
    }
  } else if (mode === 'island' && target) {
    for (const n of target) for (const p of edgeSlots(n)) pushStd(p)
  }

  // Gap-fill: holes between the relevant cluster's nodes get an individually
  // sized recommendation (fills the gap within the placement bounds).
  if (target && target.length >= 2) {
    for (const r of gapFillCandidates(target, size, gap, grid, nodeRects)) {
      cands.push({ point: snapPt(r.origin), size: r.size, custom: true })
    }
  }

  // --- Dedupe, rank (on-screen first, nearest the anchor), accept ----------
  const seen = new Set<string>()
  const ranked = cands
    .filter((c) => {
      const key = `${c.point.x},${c.point.y},${c.size.width},${c.size.height}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((c) => {
      const rect: Rect = { origin: c.point, size: c.size }
      const onScreen = onScreenRect(rect)
      const dist = Math.hypot(c.point.x + c.size.width / 2 - rankAnchor.x, c.point.y + c.size.height / 2 - rankAnchor.y)
      // Slight penalty for custom sizes so a comparable reference spot ranks first.
      return { rect, point: c.point, size: c.size, onScreen, score: (onScreen ? 0 : 1e9) + dist + (c.custom ? 60 : 0) }
    })
    .sort((a, b) => a.score - b.score)

  const accepted: PlacementCandidate[] = []
  const acceptedRects: Rect[] = []
  for (const c of ranked) {
    if (accepted.length >= cap) break
    if (!clearRect(c.rect, nodeRects)) continue
    if (!clearRect(c.rect, acceptedRects)) continue
    acceptedRects.push(c.rect)
    accepted.push({ point: c.point, size: c.size, rank: accepted.length, onScreen: c.onScreen })
  }

  if (accepted.length === 0) {
    const p = snapPt(findFreePosition(nodes, focusedNodeId, size))
    accepted.push({ point: p, size, rank: 0, onScreen: onScreenRect({ origin: p, size }) })
  }
  return accepted
}

/**
 * Snap a desired top-left to the nearest grid-aligned, overlap-free position by
 * spiralling outward. Used by the free "click-anywhere" placement escape hatch
 * so a manual drop lands cleanly instead of on top of an existing node.
 */
export function nudgeToFree(
  nodes: Record<CanvasNodeId, CanvasNodeState>,
  size: Size,
  desired: Point,
): Point {
  const grid = CANVAS_GRID_SIZE
  const snap = (v: number) => Math.round(v / grid) * grid
  const start = { x: snap(desired.x), y: snap(desired.y) }
  const nodeList = Object.values(nodes)
  const free = (p: Point) =>
    !nodeList.some((n) => rectsOverlap({ origin: n.origin, size: n.size }, { origin: p, size }))
  if (free(start)) return start
  for (let r = 1; r <= 25; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue // ring only
        const p = { x: start.x + dx * grid * 2, y: start.y + dy * grid * 2 }
        if (free(p)) return p
      }
    }
  }
  return start // give up — allow the overlap rather than refuse the placement
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(
    a.origin.x + a.size.width <= b.origin.x ||
    b.origin.x + b.size.width <= a.origin.x ||
    a.origin.y + a.size.height <= b.origin.y ||
    b.origin.y + b.size.height <= a.origin.y
  )
}

// -----------------------------------------------------------------------------
// Store factory — creates independent canvas store instances
// -----------------------------------------------------------------------------

export function createCanvasStore(): UseBoundStore<StoreApi<CanvasStore>> {
  // Each store instance gets its own zoom animation RAF tracking
  let activeZoomAnimationRafId = 0

  // Latest canvas-space pointer position (for anchoring ghost recommendations
  // to where the mouse is hovering). Kept off zustand state so high-frequency
  // mousemove updates never trigger re-renders.
  let lastPointerCanvasPos: Point | null = null

  function cancelZoomAnim() {
    if (activeZoomAnimationRafId) {
      cancelAnimationFrame(activeZoomAnimationRafId)
      activeZoomAnimationRafId = 0
    }
  }

  return create<CanvasStore>((set, get) => ({
  // --- State ---
  nodes: {},
  regions: {},
  viewportOffset: { x: 0, y: 0 },
  zoomLevel: ZOOM_DEFAULT,
  focusedNodeId: null,
  focusEpoch: 0,
  nextZOrder: 0,
  nextCreationIndex: 0,
  containerSize: { width: 0, height: 0 },
  snapGuides: { lines: [] },
  selectedNodeIds: new Set<string>(),
  selectedRegionIds: new Set<string>(),
  dropTargetRegionId: null,
  history: [],
  future: [],
  pendingPlacement: null,

  // --- Actions ---

  cancelZoomAnimation: cancelZoomAnim,

  pushHistory() {
    const state = get()
    const entry: CanvasHistoryEntry = {
      nodes: state.nodes,
      regions: state.regions,
      focusedNodeId: state.focusedNodeId,
    }
    const MAX = 100
    const history = state.history.length >= MAX
      ? [...state.history.slice(1), entry]
      : [...state.history, entry]
    set({ history, future: [] })
  },

  undo() {
    const state = get()
    if (state.history.length === 0) return
    const prev = state.history[state.history.length - 1]
    const current: CanvasHistoryEntry = {
      nodes: state.nodes,
      regions: state.regions,
      focusedNodeId: state.focusedNodeId,
    }
    set({
      nodes: prev.nodes,
      regions: prev.regions,
      focusedNodeId: prev.focusedNodeId,
      history: state.history.slice(0, -1),
      future: [...state.future, current],
    })
  },

  redo() {
    const state = get()
    if (state.future.length === 0) return
    const next = state.future[state.future.length - 1]
    const current: CanvasHistoryEntry = {
      nodes: state.nodes,
      regions: state.regions,
      focusedNodeId: state.focusedNodeId,
    }
    set({
      nodes: next.nodes,
      regions: next.regions,
      focusedNodeId: next.focusedNodeId,
      history: [...state.history, current],
      future: state.future.slice(0, -1),
    })
  },

  clearHistory() {
    set({ history: [], future: [] })
  },

  addNode(panelId, panelType, position?, size?) {
    // Canvas-on-canvas is unsupported and produces broken interaction (nested
    // zoom, ambiguous drag targets, duplicate stores keyed by the same id).
    // Refuse at the data layer regardless of which UI path tried it.
    if (panelType === 'canvas') {
      return ''
    }
    get().pushHistory()
    const state = get()
    const defaultSize = size ?? PANEL_DEFAULT_SIZES[panelType]
    // Dedupe on panelId: reposition + resize + focus the existing node.
    const existing = Object.values(state.nodes).find((n) => n.panelId === panelId)
    if (existing) {
      const { [existing.id]: _omit, ...otherNodes } = state.nodes
      const nextOrigin = findFreePosition(otherNodes, existing.id, defaultSize, position)
      set({
        nodes: {
          ...state.nodes,
          [existing.id]: {
            ...existing,
            origin: nextOrigin,
            size: defaultSize,
            zOrder: state.nextZOrder,
          },
        },
        nextZOrder: state.nextZOrder + 1,
        focusedNodeId: existing.id,
      })
      return existing.id
    }
    const nodeId = generateId()
    const origin = findFreePosition(state.nodes, state.focusedNodeId, defaultSize, position)

    const node: CanvasNodeState = {
      id: nodeId,
      panelId,
      origin,
      size: defaultSize,
      zOrder: state.nextZOrder,
      creationIndex: state.nextCreationIndex,
      animationState: IS_E2E ? 'idle' : 'entering',
      // Seed the per-node dock layout with a single tab stack containing the
      // initial panel. The CanvasNodeWrapper hydrates this into a per-node
      // DockStore on mount.
      dockLayout: {
        type: 'tabs',
        id: generateId(),
        panelIds: [panelId],
        activeIndex: 0,
      },
    }

    set({
      nodes: { ...state.nodes, [nodeId]: node },
      nextZOrder: state.nextZOrder + 1,
      nextCreationIndex: state.nextCreationIndex + 1,
    })

    return nodeId
  },

  removeNode(id) {
    if (get().nodes[id]) get().pushHistory()
    set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return {
        nodes: {
          ...state.nodes,
          [id]: { ...node, animationState: 'exiting' as const },
        },
        focusedNodeId: state.focusedNodeId === id ? null : state.focusedNodeId,
      }
    })
  },

  finalizeRemoveNode(nodeId) {
    const { [nodeId]: _, ...rest } = get().nodes
    set({ nodes: rest })
  },

  setNodeAnimationState(nodeId, state) {
    const node = get().nodes[nodeId]
    if (node) {
      set({ nodes: { ...get().nodes, [nodeId]: { ...node, animationState: state } } })
    }
  },

  moveNode(id, origin) {
    set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return {
        nodes: {
          ...state.nodes,
          [id]: { ...node, origin },
        },
      }
    })
  },

  resizeNode(id, size, origin?) {
    set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return {
        nodes: {
          ...state.nodes,
          [id]: {
            ...node,
            size,
            ...(origin != null ? { origin } : {}),
          },
        },
      }
    })
  },

  focusNode(id) {
    set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return {
        nodes: {
          ...state.nodes,
          [id]: { ...node, zOrder: state.nextZOrder },
        },
        nextZOrder: state.nextZOrder + 1,
        focusedNodeId: id,
        focusEpoch: state.focusEpoch + 1,
      }
    })
  },

  unfocus() {
    set({ focusedNodeId: null })
  },

  toggleMaximize(id, viewportSize) {
    const state = get()
    const node = state.nodes[id]
    if (!node) return

    const isMaximized = node.preMaximizeOrigin != null

    let updated: CanvasNodeState
    if (isMaximized) {
      // Restore pre-maximize geometry
      updated = {
        ...node,
        origin: node.preMaximizeOrigin!,
        size: node.preMaximizeSize!,
        preMaximizeOrigin: undefined,
        preMaximizeSize: undefined,
      }
    } else {
      // Save current geometry and maximize to fill visible canvas area
      const cs = state.containerSize
      const topLeft = get().viewToCanvas({ x: 0, y: 0 })
      const bottomRight = get().viewToCanvas({
        x: cs.width || viewportSize.width,
        y: cs.height || viewportSize.height,
      })
      const padding = 20 / state.zoomLevel

      updated = {
        ...node,
        preMaximizeOrigin: { ...node.origin },
        preMaximizeSize: { ...node.size },
        origin: {
          x: topLeft.x + padding,
          y: topLeft.y + padding,
        },
        size: {
          width: (bottomRight.x - topLeft.x) - padding * 2,
          height: (bottomRight.y - topLeft.y) - padding * 2,
        },
      }
    }

    // Focus the node as well (bump zOrder)
    updated = { ...updated, zOrder: state.nextZOrder }

    set({
      nodes: { ...state.nodes, [id]: updated },
      nextZOrder: state.nextZOrder + 1,
      focusedNodeId: id,
      focusEpoch: state.focusEpoch + 1,
    })
  },

  setZoom(level) {
    const clamped = Math.min(Math.max(level, ZOOM_MIN), ZOOM_MAX)
    set({ zoomLevel: clamped })
  },

  setViewportOffset(offset) {
    set({ viewportOffset: offset })
  },

  setZoomAndOffset(zoom, offset) {
    const clamped = Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX)
    set({ zoomLevel: clamped, viewportOffset: offset })
  },

  setContainerSize(size) {
    set({ containerSize: size })
  },

  zoomAroundCenter(newZoom) {
    const state = get()
    const clamped = Math.min(Math.max(newZoom, ZOOM_MIN), ZOOM_MAX)
    if (clamped === state.zoomLevel) return
    const cs = state.containerSize
    if (cs.width === 0 || cs.height === 0) {
      // Fallback if container size not yet measured
      set({ zoomLevel: clamped })
      return
    }
    const centerView = { x: cs.width / 2, y: cs.height / 2 }
    const centerCanvas = {
      x: (centerView.x - state.viewportOffset.x) / state.zoomLevel,
      y: (centerView.y - state.viewportOffset.y) / state.zoomLevel,
    }
    set({
      zoomLevel: clamped,
      viewportOffset: {
        x: centerView.x - centerCanvas.x * clamped,
        y: centerView.y - centerCanvas.y * clamped,
      },
    })
  },

  animateZoomTo(targetZoom) {
    cancelZoomAnim()

    const clampedTarget = Math.min(Math.max(targetZoom, ZOOM_MIN), ZOOM_MAX)

    const tick = () => {
      const state = get()
      const diff = clampedTarget - state.zoomLevel

      if (Math.abs(diff) < 0.001) {
        // Snap to exact target
        const centerX = (state.containerSize?.width || window.innerWidth) / 2
        const centerY = (state.containerSize?.height || window.innerHeight) / 2
        const canvasPoint = viewToCanvasCoords({ x: centerX, y: centerY }, state.zoomLevel, state.viewportOffset)
        set({
          zoomLevel: clampedTarget,
          viewportOffset: {
            x: centerX - canvasPoint.x * clampedTarget,
            y: centerY - canvasPoint.y * clampedTarget,
          },
        })
        activeZoomAnimationRafId = 0
        return
      }

      const newZoom = state.zoomLevel + diff * 0.15
      const centerX = (state.containerSize?.width || window.innerWidth) / 2
      const centerY = (state.containerSize?.height || window.innerHeight) / 2
      const canvasPoint = viewToCanvasCoords({ x: centerX, y: centerY }, state.zoomLevel, state.viewportOffset)
      set({
        zoomLevel: newZoom,
        viewportOffset: {
          x: centerX - canvasPoint.x * newZoom,
          y: centerY - canvasPoint.y * newZoom,
        },
      })

      activeZoomAnimationRafId = requestAnimationFrame(tick)
    }

    activeZoomAnimationRafId = requestAnimationFrame(tick)
  },

  // --- Derived getters ---

  canvasToView(point) {
    const { zoomLevel, viewportOffset } = get()
    return {
      x: point.x * zoomLevel + viewportOffset.x,
      y: point.y * zoomLevel + viewportOffset.y,
    }
  },

  viewToCanvas(point) {
    const { zoomLevel, viewportOffset } = get()
    return {
      x: (point.x - viewportOffset.x) / zoomLevel,
      y: (point.y - viewportOffset.y) / zoomLevel,
    }
  },

  viewFrame(nodeId) {
    const { nodes, zoomLevel } = get()
    const node = nodes[nodeId]
    if (!node) return null
    const viewOrigin = get().canvasToView(node.origin)
    return {
      origin: viewOrigin,
      size: {
        width: node.size.width * zoomLevel,
        height: node.size.height * zoomLevel,
      },
    }
  },

  nodeForPanel(panelId) {
    const { nodes } = get()
    const found = Object.values(nodes).find((n) => n.panelId === panelId)
    return found?.id ?? null
  },

  sortedNodesByCreationOrder() {
    const { nodes } = get()
    return Object.values(nodes).sort((a, b) => a.creationIndex - b.creationIndex)
  },

  nextNode() {
    const { focusedNodeId } = get()
    const sorted = get().sortedNodesByCreationOrder()
    if (sorted.length === 0) return null
    if (!focusedNodeId) return sorted[0].id
    const index = sorted.findIndex((n) => n.id === focusedNodeId)
    if (index === -1) return sorted[0].id
    return sorted[(index + 1) % sorted.length].id
  },

  previousNode() {
    const { focusedNodeId } = get()
    const sorted = get().sortedNodesByCreationOrder()
    if (sorted.length === 0) return null
    if (!focusedNodeId) return sorted[sorted.length - 1].id
    const index = sorted.findIndex((n) => n.id === focusedNodeId)
    if (index === -1) return sorted[sorted.length - 1].id
    return sorted[(index - 1 + sorted.length) % sorted.length].id
  },

  moveToFront(nodeId) {
    set((state) => {
      const node = state.nodes[nodeId]
      if (!node) return state
      return {
        nodes: { ...state.nodes, [nodeId]: { ...node, zOrder: state.nextZOrder } },
        nextZOrder: state.nextZOrder + 1,
      }
    })
  },

  moveToBack(nodeId) {
    set((state) => {
      const node = state.nodes[nodeId]
      if (!node) return state
      const nodeList = Object.values(state.nodes)
      const minZOrder = nodeList.reduce((min, n) => Math.min(min, n.zOrder), Infinity)
      return {
        nodes: { ...state.nodes, [nodeId]: { ...node, zOrder: minZOrder - 1 } },
      }
    })
  },

  focusAndCenter(nodeId) {
    const state = get()
    const node = state.nodes[nodeId]
    if (!node) return
    const updated = { ...node, zOrder: state.nextZOrder }
    const cs = state.containerSize
    const zoom = state.zoomLevel
    const newState: Partial<CanvasStoreState> = {
      nodes: { ...state.nodes, [nodeId]: updated },
      nextZOrder: state.nextZOrder + 1,
      focusedNodeId: nodeId,
      focusEpoch: state.focusEpoch + 1,
    }
    if (cs.width > 0 && cs.height > 0) {
      newState.viewportOffset = {
        x: cs.width / 2 - (node.origin.x + node.size.width / 2) * zoom,
        y: cs.height / 2 - (node.origin.y + node.size.height / 2) * zoom,
      }
    }
    set(newState)
  },

  setPlacementPointer(point) {
    // Intentionally not via set() — this must not cause re-renders.
    lastPointerCanvasPos = point
  },

  beginPlacement(panelId, panelType, onCancelled) {
    const state = get()
    // Re-trigger while a placement is pending: latest wins. Roll the previous
    // pending panel back before replacing it so no orphan record lingers.
    const prev = state.pendingPlacement
    if (prev && prev.panelId !== panelId) {
      prev.onCancelled?.(prev.panelId)
    }
    const candidates = recommendPlacements(
      state.nodes,
      state.focusedNodeId,
      panelType,
      { offset: state.viewportOffset, zoom: state.zoomLevel, containerSize: state.containerSize },
      lastPointerCanvasPos,
    )
    if (candidates.length === 0) return false

    // Zoom out so every recommendation (plus the focused node for context) is
    // visible at once. Only ever zoom OUT — never further in.
    let nextZoom = state.zoomLevel
    let nextOffset = state.viewportOffset
    const cs = state.containerSize
    if (cs.width > 0 && cs.height > 0) {
      const rects: Rect[] = candidates.map((c) => ({ origin: c.point, size: c.size }))
      const focused = state.focusedNodeId ? state.nodes[state.focusedNodeId] : null
      if (focused) rects.push({ origin: focused.origin, size: focused.size })
      const minX = Math.min(...rects.map((r) => r.origin.x))
      const minY = Math.min(...rects.map((r) => r.origin.y))
      const maxX = Math.max(...rects.map((r) => r.origin.x + r.size.width))
      const maxY = Math.max(...rects.map((r) => r.origin.y + r.size.height))
      const padding = 80
      const contentW = maxX - minX + padding * 2
      const contentH = maxY - minY + padding * 2
      const fitZoom = Math.min(cs.width / contentW, cs.height / contentH)
      nextZoom = Math.min(Math.max(Math.min(state.zoomLevel, fitZoom), ZOOM_MIN), ZOOM_MAX)
      nextOffset = {
        x: (cs.width - contentW * nextZoom) / 2 - (minX - padding) * nextZoom,
        y: (cs.height - contentH * nextZoom) / 2 - (minY - padding) * nextZoom,
      }
    }

    set({
      pendingPlacement: {
        panelId,
        panelType,
        candidates,
        hoveredIndex: null,
        freeArmed: false,
        freeGhost: null,
        prevZoom: state.zoomLevel,
        prevOffset: state.viewportOffset,
        onCancelled,
      },
      zoomLevel: nextZoom,
      viewportOffset: nextOffset,
    })
    return true
  },

  commitPlacement(index) {
    const pending = get().pendingPlacement
    if (!pending) return null
    const candidate = pending.candidates[index]
    if (!candidate) return null
    // Restore the pre-placement zoom, drop the ghosts, then create + centre the
    // node at the chosen recommended spot.
    set({ pendingPlacement: null, zoomLevel: pending.prevZoom })
    const nodeId = get().addNode(pending.panelId, pending.panelType, candidate.point, candidate.size)
    if (!nodeId) return null
    get().focusAndCenter(nodeId)
    return nodeId
  },

  setFreeArmed(armed) {
    const pending = get().pendingPlacement
    if (!pending || pending.freeArmed === armed) return
    set({ pendingPlacement: { ...pending, freeArmed: armed, freeGhost: armed ? pending.freeGhost : null } })
  },

  updatePlacementCursor(point) {
    const pending = get().pendingPlacement
    if (!pending) return
    const size = PANEL_DEFAULT_SIZES[pending.panelType]
    const desired = { x: point.x - size.width / 2, y: point.y - size.height / 2 }
    const p = nudgeToFree(get().nodes, size, desired)
    const cur = pending.freeGhost
    if (cur && cur.point.x === p.x && cur.point.y === p.y) return
    set({ pendingPlacement: { ...pending, freeGhost: { point: p, size } } })
  },

  commitFreePlacement(point) {
    const pending = get().pendingPlacement
    if (!pending) return null
    const size = PANEL_DEFAULT_SIZES[pending.panelType]
    const desired = { x: point.x - size.width / 2, y: point.y - size.height / 2 }
    const p = nudgeToFree(get().nodes, size, desired)
    set({ pendingPlacement: null, zoomLevel: pending.prevZoom })
    const nodeId = get().addNode(pending.panelId, pending.panelType, p, size)
    if (!nodeId) return null
    get().focusAndCenter(nodeId)
    return nodeId
  },

  cancelPlacement() {
    const pending = get().pendingPlacement
    if (!pending) return
    // Restore the viewport we zoomed out from.
    set({ pendingPlacement: null, zoomLevel: pending.prevZoom, viewportOffset: pending.prevOffset })
    pending.onCancelled?.(pending.panelId)
  },

  setPlacementHover(index) {
    const pending = get().pendingPlacement
    if (!pending || pending.hoveredIndex === index) return
    set({ pendingPlacement: { ...pending, hoveredIndex: index } })
  },

  navigateDirection(dir) {
    const state = get()
    const nodeList = Object.values(state.nodes)
    if (nodeList.length === 0) return

    // Reference center: focused node's center, else the viewport center.
    const current = state.focusedNodeId ? state.nodes[state.focusedNodeId] : null
    let refX: number
    let refY: number
    if (current) {
      refX = current.origin.x + current.size.width / 2
      refY = current.origin.y + current.size.height / 2
    } else {
      const cs = state.containerSize
      const center = get().viewToCanvas({ x: cs.width / 2, y: cs.height / 2 })
      refX = center.x
      refY = center.y
    }

    let best: CanvasNodeState | null = null
    let bestScore = Infinity
    for (const n of nodeList) {
      if (current && n.id === current.id) continue
      const dx = n.origin.x + n.size.width / 2 - refX
      const dy = n.origin.y + n.size.height / 2 - refY
      const adx = Math.abs(dx)
      const ady = Math.abs(dy)

      // Directional cone: the candidate must lie in the half-plane AND the move
      // axis must dominate, so we don't jump to a node that's mostly sideways.
      let inCone: boolean
      let score: number
      if (dir === 'left') { inCone = dx < 0 && adx >= ady; score = adx + 2 * ady }
      else if (dir === 'right') { inCone = dx > 0 && adx >= ady; score = adx + 2 * ady }
      else if (dir === 'up') { inCone = dy < 0 && ady >= adx; score = ady + 2 * adx }
      else { inCone = dy > 0 && ady >= adx; score = ady + 2 * adx }
      if (!inCone) continue

      if (score < bestScore) {
        bestScore = score
        best = n
      }
    }

    if (best) get().focusAndCenter(best.id)
  },

  zoomToFit() {
    const state = get()
    const nodeList = Object.values(state.nodes)
    if (nodeList.length === 0) return
    const cs = state.containerSize
    if (cs.width === 0 || cs.height === 0) return

    const minX = Math.min(...nodeList.map(n => n.origin.x))
    const minY = Math.min(...nodeList.map(n => n.origin.y))
    const maxX = Math.max(...nodeList.map(n => n.origin.x + n.size.width))
    const maxY = Math.max(...nodeList.map(n => n.origin.y + n.size.height))

    const padding = 60
    const contentW = maxX - minX + padding * 2
    const contentH = maxY - minY + padding * 2
    const zoom = Math.min(Math.max(Math.min(cs.width / contentW, cs.height / contentH), ZOOM_MIN), ZOOM_MAX)

    set({
      zoomLevel: zoom,
      viewportOffset: {
        x: (cs.width - contentW * zoom) / 2 - (minX - padding) * zoom,
        y: (cs.height - contentH * zoom) / 2 - (minY - padding) * zoom,
      },
    })
  },

  zoomToSelection() {
    const state = get()
    const cs = state.containerSize
    if (cs.width === 0 || cs.height === 0) return

    // Target the selection, else the focused node, else fall back to fit-all.
    let target = Object.values(state.nodes).filter((n) => state.selectedNodeIds.has(n.id))
    if (target.length === 0) {
      const focused = state.focusedNodeId ? state.nodes[state.focusedNodeId] : null
      if (focused) target = [focused]
    }
    if (target.length === 0) {
      get().zoomToFit()
      return
    }

    const minX = Math.min(...target.map(n => n.origin.x))
    const minY = Math.min(...target.map(n => n.origin.y))
    const maxX = Math.max(...target.map(n => n.origin.x + n.size.width))
    const maxY = Math.max(...target.map(n => n.origin.y + n.size.height))

    const padding = 60
    const contentW = maxX - minX + padding * 2
    const contentH = maxY - minY + padding * 2
    // Cap a single-node target so we don't over-zoom a small panel.
    const fitZoom = Math.min(cs.width / contentW, cs.height / contentH)
    const maxZoom = target.length === 1 ? Math.min(ZOOM_MAX, 1.5) : ZOOM_MAX
    const zoom = Math.min(Math.max(fitZoom, ZOOM_MIN), maxZoom)

    set({
      zoomLevel: zoom,
      viewportOffset: {
        x: (cs.width - contentW * zoom) / 2 - (minX - padding) * zoom,
        y: (cs.height - contentH * zoom) / 2 - (minY - padding) * zoom,
      },
    })
  },

  togglePin(id) {
    set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return {
        nodes: { ...state.nodes, [id]: { ...node, isPinned: !node.isPinned } },
      }
    })
  },

  setSnapGuides(guides) {
    set({ snapGuides: guides })
  },

  clearSnapGuides() {
    set({ snapGuides: { lines: [] } })
  },

  // --- Selection ---

  selectNodes(ids, additive) {
    set((state) => {
      const next = additive ? new Set(state.selectedNodeIds) : new Set<string>()
      for (const id of ids) next.add(id)
      return { selectedNodeIds: next }
    })
  },

  selectRegions(ids, additive) {
    set((state) => {
      const nextRegions = additive ? new Set(state.selectedRegionIds) : new Set<string>()
      let nextNodes = additive ? new Set(state.selectedNodeIds) : new Set<string>()
      for (const id of ids) {
        nextRegions.add(id)
        // Cascade: select all contained nodes
        for (const node of Object.values(state.nodes)) {
          if (node.regionId === id) nextNodes.add(node.id)
        }
      }
      return { selectedRegionIds: nextRegions, selectedNodeIds: nextNodes }
    })
  },

  clearSelection() {
    set({ selectedNodeIds: new Set<string>(), selectedRegionIds: new Set<string>() })
  },

  selectAll() {
    set((state) => ({
      selectedNodeIds: new Set(Object.keys(state.nodes)),
      selectedRegionIds: new Set(Object.keys(state.regions)),
    }))
  },

  toggleNodeSelection(id) {
    set((state) => {
      const next = new Set(state.selectedNodeIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selectedNodeIds: next }
    })
  },

  toggleRegionSelection(id) {
    set((state) => {
      const nextRegions = new Set(state.selectedRegionIds)
      const nextNodes = new Set(state.selectedNodeIds)
      if (nextRegions.has(id)) {
        nextRegions.delete(id)
        // Also deselect contained nodes
        for (const node of Object.values(state.nodes)) {
          if (node.regionId === id) nextNodes.delete(node.id)
        }
      } else {
        nextRegions.add(id)
        // Also select contained nodes
        for (const node of Object.values(state.nodes)) {
          if (node.regionId === id) nextNodes.add(node.id)
        }
      }
      return { selectedRegionIds: nextRegions, selectedNodeIds: nextNodes }
    })
  },

  deleteSelection(includeRegionContents) {
    const state = get()
    if (state.selectedNodeIds.size > 0 || state.selectedRegionIds.size > 0) {
      state.pushHistory()
    }

    // Collect node IDs to remove (selected nodes + region contents if requested).
    // When NOT including region contents, exclude any selected node that lives
    // inside a selected region — selectRegions() cascades into the children, so
    // without this exclusion the "region only" path would still delete them.
    const nodeIdsToRemove = new Set(state.selectedNodeIds)
    if (!includeRegionContents && state.selectedRegionIds.size > 0) {
      for (const node of Object.values(state.nodes)) {
        if (node.regionId && state.selectedRegionIds.has(node.regionId)) {
          nodeIdsToRemove.delete(node.id)
        }
      }
    }
    for (const regionId of state.selectedRegionIds) {
      if (includeRegionContents) {
        for (const node of Object.values(state.nodes)) {
          if (node.regionId === regionId) nodeIdsToRemove.add(node.id)
        }
      }
    }

    // Trigger exit animation for each node (cleanup happens in component lifecycle)
    for (const nodeId of nodeIdsToRemove) {
      get().removeNode(nodeId)
    }

    // Handle regions: detach children of non-content-deleted regions, then remove
    set((s) => {
      const updatedNodes = { ...s.nodes }
      const updatedRegions = { ...s.regions }

      for (const regionId of state.selectedRegionIds) {
        if (!includeRegionContents) {
          // Detach children that weren't deleted
          for (const nodeId of Object.keys(updatedNodes)) {
            if (updatedNodes[nodeId].regionId === regionId) {
              updatedNodes[nodeId] = { ...updatedNodes[nodeId], regionId: undefined }
            }
          }
        }
        delete updatedRegions[regionId]
      }

      return {
        nodes: updatedNodes,
        regions: updatedRegions,
        selectedNodeIds: new Set<string>(),
        selectedRegionIds: new Set<string>(),
      }
    })
  },

  autoLayout() {
    const state = get()
    const nodeList = Object.values(state.nodes).sort(
      (a, b) => a.creationIndex - b.creationIndex,
    )
    const regionList = Object.values(state.regions)
    if (nodeList.length === 0 && regionList.length === 0) {
      return
    }

    const containerWidth = state.containerSize.width > 0
      ? state.containerSize.width / state.zoomLevel
      : 1600
    const containerHeight = state.containerSize.height > 0
      ? state.containerSize.height / state.zoomLevel
      : 1000

    // Nodes-only path: uniform-size grid sized to the viewport.
    if (regionList.length === 0) {
      const gap = 6
      const n = nodeList.length
      const aspect = containerWidth / Math.max(containerHeight, 1)
      const cols = Math.max(1, Math.round(Math.sqrt(n * aspect)))
      const rows = Math.ceil(n / cols)
      const cellW = Math.max(
        240,
        (containerWidth - gap * (cols + 1)) / cols,
      )
      // Cap cell height by a panel-friendly aspect (≈ 4:3) so tall viewports
      // don't stretch panels vertically.
      const maxCellH = cellW * 0.72
      const cellH = Math.min(
        maxCellH,
        Math.max(160, (containerHeight - gap * (rows + 1)) / rows),
      )
      get().pushHistory()
      const updatedNodes = { ...state.nodes }
      nodeList.forEach((node, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        updatedNodes[node.id] = {
          ...updatedNodes[node.id],
          origin: {
            x: gap + col * (cellW + gap),
            y: gap + row * (cellH + gap),
          },
          size: { width: cellW, height: cellH },
        }
      })
      set({ nodes: updatedNodes })
      get().zoomToFit()
      return
    }

    const result = computeAutoLayoutAll({
      nodes: nodeList,
      regions: regionList,
      containerWidth,
      containerHeight,
      gap: 40,
    })

    get().pushHistory()

    const updatedNodes = { ...state.nodes }
    for (const [id, origin] of Object.entries(result.nodeOrigins)) {
      if (updatedNodes[id]) updatedNodes[id] = { ...updatedNodes[id], origin }
    }

    const updatedRegions = { ...state.regions }
    for (const [id, origin] of Object.entries(result.regionOrigins)) {
      if (!updatedRegions[id]) continue
      const size = result.regionSizes[id] ?? updatedRegions[id].size
      updatedRegions[id] = { ...updatedRegions[id], origin, size }
    }

    set({
      nodes: updatedNodes,
      regions: updatedRegions,
    })

    // Zoom to fit after layout
    get().zoomToFit()
  },

  addRegion(label, origin, size, color) {
    const id = generateId()
    const region: CanvasRegion = {
      id,
      origin,
      size,
      label,
      color: color || REGION_FILL_COLORS[0],
      zOrder: -1000,
    }
    set((state) => ({
      regions: { ...state.regions, [id]: region },
    }))
    return id
  },

  removeRegion(id) {
    set((state) => {
      const { [id]: _, ...rest } = state.regions
      return { regions: rest }
    })
  },

  moveRegion(id, origin) {
    set((state) => {
      const region = state.regions[id]
      if (!region) return state
      const dx = origin.x - region.origin.x
      const dy = origin.y - region.origin.y
      const updatedNodes = { ...state.nodes }
      for (const node of Object.values(state.nodes)) {
        if (node.regionId === id) {
          updatedNodes[node.id] = {
            ...node,
            origin: { x: node.origin.x + dx, y: node.origin.y + dy },
          }
        }
      }
      return {
        regions: { ...state.regions, [id]: { ...region, origin } },
        nodes: updatedNodes,
      }
    })
  },

  resizeRegion(id, size, origin) {
    set((state) => {
      const region = state.regions[id]
      if (!region) return state
      return {
        regions: {
          ...state.regions,
          [id]: { ...region, size, ...(origin ? { origin } : {}) },
        },
      }
    })
  },

  renameRegion(id, label) {
    set((state) => {
      const region = state.regions[id]
      if (!region) return state
      return {
        regions: { ...state.regions, [id]: { ...region, label } },
      }
    })
  },

  updateRegionColor(id, color) {
    set((state) => {
      const region = state.regions[id]
      if (!region) return state
      return {
        regions: { ...state.regions, [id]: { ...region, color } },
      }
    })
  },

  setRegionDefaultCwd(id, defaultCwd) {
    set((state) => {
      const region = state.regions[id]
      if (!region) return state
      return {
        regions: { ...state.regions, [id]: { ...region, defaultCwd } },
      }
    })
  },

  // --- Containment ---

  setNodeRegion(nodeId, regionId) {
    set((state) => {
      const node = state.nodes[nodeId]
      if (!node) return state
      return {
        nodes: { ...state.nodes, [nodeId]: { ...node, regionId } },
      }
    })
  },

  getNodesInRegion(regionId) {
    return Object.values(get().nodes).filter((n) => n.regionId === regionId)
  },

  groupSelectedIntoRegion() {
    const state = get()
    const selectedNodes = Object.values(state.nodes).filter((n) => state.selectedNodeIds.has(n.id))
    if (selectedNodes.length === 0) return null

    // Compute bounding box with padding
    const padding = 30
    const minX = Math.min(...selectedNodes.map((n) => n.origin.x)) - padding
    const minY = Math.min(...selectedNodes.map((n) => n.origin.y)) - padding
    const maxX = Math.max(...selectedNodes.map((n) => n.origin.x + n.size.width)) + padding
    const maxY = Math.max(...selectedNodes.map((n) => n.origin.y + n.size.height)) + padding

    const regionId = get().addRegion(
      'Region',
      { x: minX, y: minY },
      { width: maxX - minX, height: maxY - minY },
    )

    // Assign regionId to all selected nodes
    set((s) => {
      const updatedNodes = { ...s.nodes }
      for (const node of selectedNodes) {
        updatedNodes[node.id] = { ...updatedNodes[node.id], regionId }
      }
      return { nodes: updatedNodes }
    })

    return regionId
  },

  groupSelectedHorizontal() {
    const state = get()
    const selectedNodes = Object.values(state.nodes).filter((n) => state.selectedNodeIds.has(n.id))
    if (selectedNodes.length === 0) return null

    get().pushHistory()

    const gap = 12
    const padding = 30
    const n = selectedNodes.length

    // Roughly-square grid: prefer slightly wider than tall.
    const cols = Math.ceil(Math.sqrt(n))
    const rows = Math.ceil(n / cols)

    // Normalize cell size to the median of the selection so the grid looks tidy.
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b)
      const m = Math.floor(s.length / 2)
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
    }
    const cellW = Math.round(median(selectedNodes.map((nd) => nd.size.width)))
    const cellH = Math.round(median(selectedNodes.map((nd) => nd.size.height)))

    // Anchor the grid at the top-left of the current selection bounds.
    const startX = Math.min(...selectedNodes.map((nd) => nd.origin.x))
    const startY = Math.min(...selectedNodes.map((nd) => nd.origin.y))

    // Preserve current visual order: sort row-major by (y, x).
    const sorted = [...selectedNodes].sort(
      (a, b) => a.origin.y - b.origin.y || a.origin.x - b.origin.x,
    )

    const regionId = get().addRegion(
      'Group',
      { x: startX - padding, y: startY - padding },
      {
        width: cols * cellW + (cols - 1) * gap + padding * 2,
        height: rows * cellH + (rows - 1) * gap + padding * 2,
      },
    )

    set((s) => {
      const updatedNodes = { ...s.nodes }
      sorted.forEach((nd, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        updatedNodes[nd.id] = {
          ...updatedNodes[nd.id],
          origin: { x: startX + col * (cellW + gap), y: startY + row * (cellH + gap) },
          size: { width: cellW, height: cellH },
          regionId,
        }
      })
      return { nodes: updatedNodes }
    })

    return regionId
  },

  stackSelected(axis, gap = 16) {
    get().pushHistory()
    set((state) => {
      const selected = Object.values(state.nodes).filter((n) => state.selectedNodeIds.has(n.id))
      if (selected.length < 2) return state

      const row = axis === 'row'
      const sorted = [...selected].sort((a, b) =>
        row ? a.origin.x - b.origin.x : a.origin.y - b.origin.y,
      )
      // Anchor at the selection's top-left so the stack stays where the user
      // already placed it.
      const startX = Math.min(...selected.map((n) => n.origin.x))
      const startY = Math.min(...selected.map((n) => n.origin.y))

      const next = { ...state.nodes }
      let cursor = row ? startX : startY
      for (const n of sorted) {
        const x = row ? cursor : startX
        const y = row ? startY : cursor
        next[n.id] = { ...n, origin: { x, y } }
        cursor += (row ? n.size.width : n.size.height) + gap
      }
      return { nodes: next }
    })
  },

  tidyGridSelected(gap = 16) {
    get().pushHistory()
    set((state) => {
      const selected = Object.values(state.nodes).filter((n) => state.selectedNodeIds.has(n.id))
      if (selected.length < 2) return state

      const n = selected.length
      const cols = Math.ceil(Math.sqrt(n))

      // Use the max dimensions so nothing overlaps even with mixed sizes.
      const cellW = Math.max(...selected.map((nd) => nd.size.width))
      const cellH = Math.max(...selected.map((nd) => nd.size.height))

      const startX = Math.min(...selected.map((nd) => nd.origin.x))
      const startY = Math.min(...selected.map((nd) => nd.origin.y))

      // Preserve visual reading order: row-major by current (y, x).
      const sorted = [...selected].sort(
        (a, b) => a.origin.y - b.origin.y || a.origin.x - b.origin.x,
      )

      const next = { ...state.nodes }
      sorted.forEach((nd, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        next[nd.id] = {
          ...nd,
          origin: { x: startX + col * (cellW + gap), y: startY + row * (cellH + gap) },
        }
      })
      return { nodes: next }
    })
  },

  dissolveRegion(regionId) {
    set((state) => {
      // Detach all children
      const updatedNodes = { ...state.nodes }
      for (const nodeId of Object.keys(updatedNodes)) {
        if (updatedNodes[nodeId].regionId === regionId) {
          updatedNodes[nodeId] = { ...updatedNodes[nodeId], regionId: undefined }
        }
      }
      // Remove the region
      const { [regionId]: _, ...restRegions } = state.regions
      // Remove from selection
      const nextRegionIds = new Set(state.selectedRegionIds)
      nextRegionIds.delete(regionId)
      return { nodes: updatedNodes, regions: restRegions, selectedRegionIds: nextRegionIds }
    })
  },

  setNodeDockLayout(nodeId, layout) {
    set((state) => {
      const node = state.nodes[nodeId]
      if (!node) return state
      return {
        nodes: {
          ...state.nodes,
          [nodeId]: { ...node, dockLayout: layout },
        },
      }
    })
  },

  loadWorkspaceCanvas(nodes, viewportOffset, zoomLevel, focusedNodeId, regions) {
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
      regions: regions ?? {},
      viewportOffset,
      zoomLevel: Math.min(Math.max(zoomLevel, ZOOM_MIN), ZOOM_MAX),
      focusedNodeId,
      nextZOrder: maxZOrder + 1,
      nextCreationIndex: maxCreationIndex + 1,
      selectedNodeIds: new Set<string>(),
      selectedRegionIds: new Set<string>(),
      history: [],
      future: [],
      pendingPlacement: null,
    })
  },
}))
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
  // First panel to register inherits the legacy singleton — keeps session-
  // restore and sidebar code paths that read `useCanvasStore` working.
  const session = getDefaultSession()
  let store: UseBoundStore<StoreApi<CanvasStore>>
  if (session.getAllCanvasStores().length === 0) {
    store = useCanvasStore
  } else {
    store = createCanvasStore()
  }
  canvasBoundStoresByPanelId.set(panelId, store)
  session.registerCanvasStore(panelId, store)
  return store
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

/** @deprecated Use store.getState().cancelZoomAnimation() instead */
export function cancelZoomAnimation() {
  useCanvasStore.getState().cancelZoomAnimation()
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
    (a, b) => {
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false
      }
      return true
    },
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
      const { nodes, viewportOffset, zoomLevel, containerSize, focusedNodeId } = s
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
    (a, b) => {
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false
      }
      return true
    },
  )
}
