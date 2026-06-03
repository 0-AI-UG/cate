// =============================================================================
// Placement — pure algorithm for recommending where a new canvas node goes.
//
// Powers the interactive "ghost" placement picker (recommendPlacements) and the
// non-interactive auto-placement path (findFreePosition / nudgeToFree). No store
// or React dependencies: nodes in, candidate spots out. The canvas store holds
// the picker state and renders the result.
// =============================================================================

import type { CanvasNodeId, CanvasNodeState, Point, Size, Rect, PanelType } from '../../shared/types'
import { PANEL_DEFAULT_SIZES } from '../../shared/types'
import { CANVAS_GRID_SIZE } from './layoutEngine'
import { viewToCanvas as viewToCanvasCoords } from '../lib/coordinates'

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


/**
 * Find a free position for a new node that does not overlap any existing node.
 * From the reference node (focused, else most recently created) search outward
 * in all four cardinal directions, jumping past obstacles along each ray, and
 * return the slot whose center is closest to the reference's center.
 */
export function findFreePosition(
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

// --- Geometry helpers --------------------------------------------------------

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
 * Recommend where a new node should go, for the interactive "ghost" picker.
 *
 * Minimal model: find the ACTIVE node (the focused one if on screen, else the
 * on-screen node nearest the viewport centre), then look at the empty rectangles
 * around it and drop one panel into each — hugging the active node, sized to the
 * hole. A standard panel is used wherever it fits; a smaller hole gets a panel
 * shrunk to fill it (individualized). With no nodes (or panned to blank space)
 * it offers a few spots centred where the user is looking.
 *
 * @param anchor canvas-space point (mouse pos) used to rank spots and centre the
 *               empty-canvas case; falls back to the viewport / active centre.
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
  const snapPt = (p: Point): Point => ({ x: Math.round(p.x / grid) * grid, y: Math.round(p.y / grid) * grid })
  const gap = PLACEMENT_GAP
  const std = PANEL_DEFAULT_SIZES[panelType]

  const { offset, zoom, containerSize } = viewport
  const hasVp = containerSize.width > 0 && containerSize.height > 0
  const vTL = viewToCanvasCoords({ x: 0, y: 0 }, zoom, offset)
  const vBR = viewToCanvasCoords({ x: containerSize.width, y: containerSize.height }, zoom, offset)
  const viewRect: Rect = { origin: vTL, size: { width: vBR.x - vTL.x, height: vBR.y - vTL.y } }
  const viewCenter: Point = { x: vTL.x + viewRect.size.width / 2, y: vTL.y + viewRect.size.height / 2 }
  const onScreen = (r: Rect): boolean => hasVp && rectsOverlap(r, viewRect)

  const nodeList = Object.values(nodes)
  const nodeRects: Rect[] = nodeList.map((n) => ({ origin: n.origin, size: n.size }))

  type Raw = { point: Point; size: Size }

  // Rank by proximity to `rankAt` (on-screen first), dedupe, and accept only spots
  // that keep a gap to every node and to each other. Always returns ≥1.
  const finalize = (raw: Raw[], rankAt: Point): PlacementCandidate[] => {
    const clear = (rect: Rect, others: Rect[]) => !others.some((r) => rectsOverlap(inflateRect(rect, gap - 1), r))
    const seen = new Set<string>()
    const ranked = raw
      .map((c) => ({ point: snapPt(c.point), size: c.size }))
      .filter((c) => {
        const k = `${c.point.x},${c.point.y},${c.size.width},${c.size.height}`
        return seen.has(k) ? false : (seen.add(k), true)
      })
      .map((c) => {
        const rect: Rect = { origin: c.point, size: c.size }
        const vis = onScreen(rect)
        const dist = Math.hypot(c.point.x + c.size.width / 2 - rankAt.x, c.point.y + c.size.height / 2 - rankAt.y)
        return { rect, point: c.point, size: c.size, vis, score: (vis ? 0 : 1e9) + dist }
      })
      .sort((a, b) => a.score - b.score)

    const out: PlacementCandidate[] = []
    const taken: Rect[] = []
    for (const c of ranked) {
      if (out.length >= max) break
      if (!clear(c.rect, nodeRects) || !clear(c.rect, taken)) continue
      taken.push(c.rect)
      out.push({ point: c.point, size: c.size, rank: out.length, onScreen: c.vis })
    }
    if (out.length === 0) {
      const p = snapPt(findFreePosition(nodes, focusedNodeId, std))
      out.push({ point: p, size: std, rank: 0, onScreen: onScreen({ origin: p, size: std }) })
    }
    return out
  }

  // A few standard spots centred on a point (empty canvas / blank viewport).
  const centred = (c: Point): Raw[] => {
    const tl = { x: c.x - std.width / 2, y: c.y - std.height / 2 }
    return [
      { point: tl, size: std },
      { point: { x: tl.x + std.width + gap, y: tl.y }, size: std },
      { point: { x: tl.x, y: tl.y + std.height + gap }, size: std },
    ]
  }

  if (nodeList.length === 0) {
    const c = anchor ?? (hasVp ? viewCenter : { x: 100 + std.width / 2, y: 100 + std.height / 2 })
    return finalize(centred(c), c)
  }

  const onScreenNodes = nodeList.filter((n) => onScreen({ origin: n.origin, size: n.size }))
  if (onScreenNodes.length === 0) {
    const c = anchor ?? viewCenter // panned to empty space → place where looking
    return finalize(centred(c), c)
  }

  // ACTIVE node: focused (if on screen) else the on-screen node nearest the view.
  const focused = (focusedNodeId && nodes[focusedNodeId]) || null
  const distToView = (n: CanvasNodeState) =>
    Math.hypot(n.origin.x + n.size.width / 2 - viewCenter.x, n.origin.y + n.size.height / 2 - viewCenter.y)
  const active =
    focused && onScreen({ origin: focused.origin, size: focused.size })
      ? focused
      : onScreenNodes.reduce((b, n) => (distToView(n) < distToView(b) ? n : b))

  const aRect: Rect = { origin: active.origin, size: active.size }
  const aCenter: Point = { x: aRect.origin.x + aRect.size.width / 2, y: aRect.origin.y + aRect.size.height / 2 }

  // A lattice anchored on the active node's edges: each cell is one panel + gap
  // away, aligned to the node, so spots extend its grid. The first cell in each
  // direction hugs the node's edge; further cells step by one panel pitch.
  const cellX = (i: number): number =>
    i === 0 ? aRect.origin.x
      : i > 0 ? aRect.origin.x + aRect.size.width + gap + (i - 1) * (std.width + gap)
        : aRect.origin.x - (std.width + gap) - (-i - 1) * (std.width + gap)
  const cellY = (j: number): number =>
    j === 0 ? aRect.origin.y
      : j > 0 ? aRect.origin.y + aRect.size.height + gap + (j - 1) * (std.height + gap)
        : aRect.origin.y - (std.height + gap) - (-j - 1) * (std.height + gap)

  // Largest panel (≤ standard, ≥ min) that fits at top-left `p`, bounded by the
  // nearest node to the right/below — so a cell crowded by a neighbour shrinks.
  const occupied = (p: Point): boolean =>
    nodeRects.some((r) => rectsOverlap({ origin: p, size: { width: PLACEMENT_MIN_W, height: PLACEMENT_MIN_H } }, r))
  const fitAt = (p: Point): Size | null => {
    let right = p.x + std.width
    let bottom = p.y + std.height
    for (const r of nodeRects) {
      const rL = r.origin.x, rR = rL + r.size.width, rT = r.origin.y, rB = rT + r.size.height
      if (rL >= p.x + 1 && rT < p.y + std.height && rB > p.y) right = Math.min(right, rL - gap)
      if (rT >= p.y + 1 && rL < p.x + std.width && rR > p.x) bottom = Math.min(bottom, rT - gap)
    }
    if (right - p.x < PLACEMENT_MIN_W || bottom - p.y < PLACEMENT_MIN_H) return null
    return clampPlacementSize(right - p.x, bottom - p.y, grid)
  }

  // Breadth-first outward from the node (nearest cells first), expanding only
  // through free cells so the group stays connected and hugs the node.
  const visited = new Set<string>(['0,0'])
  const queue: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const raw: Raw[] = []
  while (queue.length > 0 && raw.length < max * 3) {
    queue.sort((a, b) =>
      (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1])) ||
      (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]))
    const [i, j] = queue.shift()!
    const key = `${i},${j}`
    if (visited.has(key)) continue
    visited.add(key)
    const p = snapPt({ x: cellX(i), y: cellY(j) })
    if (occupied(p)) continue // a node sits here — don't place or expand through
    const size = fitAt(p)
    if (!size) continue
    raw.push({ point: p, size })
    queue.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1])
  }

  return finalize(raw, anchor ?? aCenter)
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
