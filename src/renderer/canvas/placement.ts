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
import { CANVAS_GRID_SIZE, snapScalar, snapToGrid, rectsOverlap } from './layoutEngine'
import { viewToCanvas as viewToCanvasCoords } from '../lib/canvas/coordinates'

/** A recommended spot for a new node, surfaced as a numbered, clickable "ghost".
 *  Best first; the on-screen number is the array index + 1. */
export interface PlacementCandidate {
  /** Snapped canvas-space top-left origin for the new node. */
  point: Point
  /** The size the ghost (and resulting node) would have. */
  size: Size
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
  const snap = (v: number) => snapScalar(v, grid)

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
/** A recommendation is never smaller than MIN (a gap tighter than this is pruned,
 *  so it gets no recommendation) and, when it grows to fill a bounded gap, never
 *  larger than MAX (a very wide gap doesn't yield an enormous panel). */
const PLACEMENT_MIN_W = 280
const PLACEMENT_MIN_H = 180
const PLACEMENT_MAX_W = 1400
const PLACEMENT_MAX_H = 900
const EPS = 1
const SNAP_TOL = PLACEMENT_GAP / 2

/** Sorted, deduped alignment lines implied by the existing windows: each edge plus
 *  edge ± gap, so a new panel can land on a shared column/row or exactly one gap away. */
export function deriveGuides(
  nodes: Record<CanvasNodeId, CanvasNodeState>,
  gap: number,
): { xs: number[]; ys: number[] } {
  const xs = new Set<number>()
  const ys = new Set<number>()
  for (const n of Object.values(nodes)) {
    const l = n.origin.x, r = n.origin.x + n.size.width
    const t = n.origin.y, b = n.origin.y + n.size.height
    for (const x of [l, r]) { xs.add(x); xs.add(x + gap); xs.add(x - gap) }
    for (const y of [t, b]) { ys.add(y); ys.add(y + gap); ys.add(y - gap) }
  }
  return {
    xs: [...xs].sort((a, b) => a - b),
    ys: [...ys].sort((a, b) => a - b),
  }
}
// --- Geometry helpers --------------------------------------------------------

/** Grow a rect by `m` on every side. */
function inflateRect(r: Rect, m: number): Rect {
  return {
    origin: { x: r.origin.x - m, y: r.origin.y - m },
    size: { width: r.size.width + m * 2, height: r.size.height + m * 2 },
  }
}

/** True when rect `a` is fully contained within rect `b`. */
function rectContains(b: Rect, a: Rect): boolean {
  return (
    a.origin.x >= b.origin.x - 0.5 &&
    a.origin.y >= b.origin.y - 0.5 &&
    a.origin.x + a.size.width <= b.origin.x + b.size.width + 0.5 &&
    a.origin.y + a.size.height <= b.origin.y + b.size.height + 0.5
  )
}

/** Split free rect `f` by obstacle `obs` into up to four maximal remainder slabs
 *  (left / right / above / below). Returns `[f]` if they don't overlap. The slabs
 *  overlap at the corners — that's correct for maximal rectangles; the packer
 *  carves placed ghosts out the same way. */
function splitFree(f: Rect, obs: Rect): Rect[] {
  if (!rectsOverlap(f, obs)) return [f]
  const fL = f.origin.x, fT = f.origin.y, fR = fL + f.size.width, fB = fT + f.size.height
  const oL = obs.origin.x, oT = obs.origin.y, oR = oL + obs.size.width, oB = oT + obs.size.height
  const out: Rect[] = []
  if (oL > fL) out.push({ origin: { x: fL, y: fT }, size: { width: oL - fL, height: f.size.height } })
  if (oR < fR) out.push({ origin: { x: oR, y: fT }, size: { width: fR - oR, height: f.size.height } })
  if (oT > fT) out.push({ origin: { x: fL, y: fT }, size: { width: f.size.width, height: oT - fT } })
  if (oB < fB) out.push({ origin: { x: fL, y: oB }, size: { width: f.size.width, height: fB - oB } })
  return out
}

/** Drop too-small (< PLACEMENT_MIN) and subsumed rects from a free-rect list, and
 *  cap the count for speed. */
function pruneFreeRects(rects: Rect[]): Rect[] {
  const out: Rect[] = []
  for (const r of rects) {
    if (r.size.width < PLACEMENT_MIN_W || r.size.height < PLACEMENT_MIN_H) continue
    if (out.some((o) => rectContains(o, r))) continue
    for (let i = out.length - 1; i >= 0; i--) if (rectContains(r, out[i])) out.splice(i, 1)
    out.push(r)
    if (out.length >= 80) break
  }
  return out
}

/** Decompose `area` minus `obstacles` into its maximal empty rectangles (each at
 *  least PLACEMENT_MIN in size). Obstacles should already be inflated by the gap so
 *  every emitted rect keeps its clearance. */
function freeRectangles(area: Rect, obstacles: Rect[]): Rect[] {
  let free: Rect[] = [area]
  for (const obs of obstacles) free = pruneFreeRects(free.flatMap((f) => splitFree(f, obs)))
  return free
}

/**
 * Recommend where a new node should go, for the interactive "ghost" picker.
 *
 * Model: decompose the free space (a place area minus the existing windows) into
 * empty rectangles, then PACK ghosts into it nearest-first — each step drops one
 * ghost into the free spot closest to the ranking point, carves it out, and repeats.
 * Using the nearest free space first means no closer empty spot is ever left unused,
 * so the result stays tight with no odd gaps even when the windows aren't on a grid.
 *
 * Sizing is ORGANIC GROWTH: along an axis where the empty rectangle is pinned by a
 * window on BOTH sides (an interior gap) the ghost grows to fill that gap, up to the
 * max size; an axis open on either side has nothing to size it, so it falls back to
 * the panel's default extent.
 *
 *  - A focused node on screen → packs around it (ranked from its centre).
 *  - Nothing focused → packs across the viewport, ranked from the cursor.
 *  - No nodes (or panned to blank space) → a few spots centred where you're looking.
 *
 * @param anchor canvas-space point (mouse pos) used to rank spots and centre the
 *               empty-canvas case; falls back to the viewport / focused centre.
 */
export function recommendPlacements(
  nodes: Record<CanvasNodeId, CanvasNodeState>,
  focusedNodeId: CanvasNodeId | null,
  panelType: PanelType,
  viewport: { offset: Point; zoom: number; containerSize: Size },
  anchor: Point | null,
  max = 6,
  sizeOverride?: Size,
): PlacementCandidate[] {
  const grid = CANVAS_GRID_SIZE
  const snapPt = (p: Point): Point => snapToGrid(p, grid)
  const gap = PLACEMENT_GAP
  const std = sizeOverride ?? PANEL_DEFAULT_SIZES[panelType]

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
      out.push({ point: c.point, size: c.size })
    }
    if (out.length === 0) {
      const p = snapPt(findFreePosition(nodes, focusedNodeId, std))
      out.push({ point: p, size: std })
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

  // PLACE AREA + ranking point. A focused node on screen → a generous area around
  // it, ranked from its centre so recs hug it. Otherwise → the whole viewport,
  // ranked from the cursor (a wider spread, biased to where you're looking).
  const focused = (focusedNodeId && nodes[focusedNodeId]) || null
  const focusedOnScreen = !!focused && onScreen({ origin: focused.origin, size: focused.size })
  const pitchX = std.width + gap
  const pitchY = std.height + gap

  let area: Rect
  let rankAt: Point
  if (focusedOnScreen && focused) {
    const mx = pitchX * 2
    const my = pitchY * 2
    area = {
      origin: { x: focused.origin.x - mx, y: focused.origin.y - my },
      size: { width: focused.size.width + mx * 2, height: focused.size.height + my * 2 },
    }
    rankAt = { x: focused.origin.x + focused.size.width / 2, y: focused.origin.y + focused.size.height / 2 }
  } else {
    rankAt = anchor ?? viewCenter
    area = viewRect
  }

  // Pack ghosts into the FREE SPACE, nearest the ranking point first. Each step
  // drops one ghost into the empty rectangle whose best spot is closest to the
  // ranking point, then carves that ghost (plus its gap) out of the free space and
  // repeats. Because the nearest free space is always used first, no closer empty
  // spot is ever left unused — which is what keeps the result tight in irregular
  // layouts.
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  const inflated = nodeRects.map((r) => inflateRect(r, gap))
  let free = freeRectangles(area, inflated)

  // An axis of free rect `f` is "pinned" when a window's opposite edge sits against
  // BOTH of its sides (an interior gap), sharing a run along the edge. A pinned axis
  // grows to fill the gap; an open axis falls back to the default extent.
  const pinnedX = (f: Rect): boolean => {
    const fL = f.origin.x, fR = fL + f.size.width, fT = f.origin.y, fB = fT + f.size.height
    let left = false, right = false
    for (const o of inflated) {
      if (Math.min(o.origin.y + o.size.height, fB) - Math.max(o.origin.y, fT) <= EPS) continue
      if (Math.abs(o.origin.x + o.size.width - fL) <= EPS) left = true
      if (Math.abs(o.origin.x - fR) <= EPS) right = true
    }
    return left && right
  }
  const pinnedY = (f: Rect): boolean => {
    const fL = f.origin.x, fR = fL + f.size.width, fT = f.origin.y, fB = fT + f.size.height
    let top = false, bottom = false
    for (const o of inflated) {
      if (Math.min(o.origin.x + o.size.width, fR) - Math.max(o.origin.x, fL) <= EPS) continue
      if (Math.abs(o.origin.y + o.size.height - fT) <= EPS) top = true
      if (Math.abs(o.origin.y - fB) <= EPS) bottom = true
    }
    return top && bottom
  }

  const raw: Raw[] = []
  for (let n = 0; n < max && free.length > 0; n++) {
    let best: { point: Point; size: Size; score: number } | null = null
    for (const f of free) {
      // Grid-aligned interior of the rect (it already carries the gap, so staying
      // inside it keeps the clearance).
      const ix0 = Math.ceil(f.origin.x / grid) * grid
      const ix1 = Math.floor((f.origin.x + f.size.width) / grid) * grid
      const iy0 = Math.ceil(f.origin.y / grid) * grid
      const iy1 = Math.floor((f.origin.y + f.size.height) / grid) * grid
      const availW = ix1 - ix0, availH = iy1 - iy0
      if (availW < PLACEMENT_MIN_W || availH < PLACEMENT_MIN_H) continue
      // Fill a pinned axis (capped at the max); otherwise take the default, shrunk
      // to fit if the rect is narrower/shorter than it.
      const w = clamp(pinnedX(f) ? availW : Math.min(std.width, availW), PLACEMENT_MIN_W, Math.min(PLACEMENT_MAX_W, availW))
      const h = clamp(pinnedY(f) ? availH : Math.min(std.height, availH), PLACEMENT_MIN_H, Math.min(PLACEMENT_MAX_H, availH))
      // Position at the point of the rect closest to the ranking point (a fully
      // filled axis has only the one position).
      const point = {
        x: clamp(Math.round((rankAt.x - w / 2) / grid) * grid, ix0, ix1 - w),
        y: clamp(Math.round((rankAt.y - h / 2) / grid) * grid, iy0, iy1 - h),
      }
      const score = Math.hypot(point.x + w / 2 - rankAt.x, point.y + h / 2 - rankAt.y)
      if (!best || score < best.score) best = { point, size: { width: w, height: h }, score }
    }
    if (!best) break
    raw.push({ point: best.point, size: best.size })
    const placed = inflateRect({ origin: best.point, size: best.size }, gap)
    free = pruneFreeRects(free.flatMap((f) => splitFree(f, placed)))
  }

  return finalize(raw, rankAt)
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
  const snap = (v: number) => snapScalar(v, grid)
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
