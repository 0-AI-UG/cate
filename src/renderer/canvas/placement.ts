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

/** One packing iteration's inputs and decision — diagnostics for the picker only. */
export interface PlacementTraceStep {
  free: Rect[]
  chosen: Rect
  matchedWidth: number | null
  matchedHeight: number | null
  filled: boolean
  size: Size
  point: Point
}

/** Optional out-param capturing the full reasoning of a recommendPlacements run. */
export interface PlacementTrace {
  area: Rect
  rankAt: Point
  inflated: Rect[]
  guides: { xs: number[]; ys: number[] }
  steps: PlacementTraceStep[]
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
 *  so it gets no recommendation) and, when it mirrors a large neighbor, never
 *  larger than MAX (a huge neighbor doesn't yield an enormous panel). */
const PLACEMENT_MIN_W = 280
const PLACEMENT_MIN_H = 180
const PLACEMENT_MAX_W = 1400
const PLACEMENT_MAX_H = 900
const EPS = 1
const SNAP_TOL = PLACEMENT_GAP / 2
const FIT_TOL = CANVAS_GRID_SIZE // one grid step of allowed shortfall
// Grow-to-fill only offers a gap this big or larger, so an empty gap that doesn't
// match a neighbor still gets used without producing a thin sliver. Tuning values
// (the dev viz, Cmd/Ctrl+Shift+G, is the tool for adjusting them).
const USEFUL_MIN_W = 400
const USEFUL_MIN_H = 340
// A grown-to-fill gap is only offered if its shape stays near the panel's natural
// aspect ratio — a narrow/tall or wide/flat gap would fill into an awkward tile.
// (Mirror tiles match a real window's shape, so they're exempt.) Tunable via the viz.
const FILL_AR_FACTOR = 1.6

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

/** Original size of the window adjacent to `f` (touching any one of its four sides
 *  with a positive shared run) that has the LONGEST shared run along its touching
 *  edge; tie-broken by the neighbor center nearest `rankAt` along that run's axis.
 *  Returns the ORIGINAL size (inflated minus the gap on both sides), or null when
 *  nothing is adjacent. Used to mirror a neighbor's size onto a new panel. */
export function matchedNeighborSize(f: Rect, inflated: Rect[], gap: number, rankAt: Point): Size | null {
  const fL = f.origin.x, fR = fL + f.size.width, fT = f.origin.y, fB = fT + f.size.height
  let bestRun = 0, bestDist = Infinity, best: Size | null = null
  for (const o of inflated) {
    const oL = o.origin.x, oR = oL + o.size.width, oT = o.origin.y, oB = oT + o.size.height
    const vAdjacent = Math.abs(oB - fT) <= EPS || Math.abs(oT - fB) <= EPS // above/below → horizontal run
    const hAdjacent = Math.abs(oR - fL) <= EPS || Math.abs(oL - fR) <= EPS // left/right → vertical run
    let run = 0, dist = 0
    if (vAdjacent) {
      run = Math.min(oR, fR) - Math.max(oL, fL)
      dist = Math.abs((oL + oR) / 2 - rankAt.x)
    } else if (hAdjacent) {
      run = Math.min(oB, fB) - Math.max(oT, fT)
      dist = Math.abs((oT + oB) / 2 - rankAt.y)
    } else {
      continue
    }
    if (run <= EPS) continue
    if (run > bestRun + EPS || (Math.abs(run - bestRun) <= EPS && dist < bestDist)) {
      bestRun = run; bestDist = dist
      best = { width: oR - oL - 2 * gap, height: oB - oT - 2 * gap }
    }
  }
  return best
}

/** Snap the low edge of a fixed-size span to the nearest alignment guide (via either
 *  edge) when within `tol`; otherwise snap the low edge to the grid. */
export function snapAxis(lo: number, size: number, guides: number[], tol: number, grid: number): number {
  let best = Math.round(lo / grid) * grid
  let bestErr = tol
  const hi = lo + size
  for (const g of guides) {
    const eLo = Math.abs(g - lo)
    if (eLo < bestErr) { bestErr = eLo; best = g }
    const eHi = Math.abs(g - hi)
    if (eHi < bestErr) { bestErr = eHi; best = g - size }
  }
  return best
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
 * Sizing is a PURE MIRROR GRID: when a window is adjacent to the rect, the ghost
 * takes that neighbor's FULL size — both width and height — clamped to [MIN,MAX]. A
 * rect too small to host the full target size is SKIPPED (no shrunken slivers, no
 * grow-to-fill). Only when no window is adjacent does the ghost fall back to the
 * panel's default size.
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
  trace?: PlacementTrace,
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
      // Trust incoming points: the packer already positioned each spot on a guide
      // or the grid and clamped it inside its gap-carrying free rect. Re-snapping
      // here would nudge a guide-aligned spot (common when a window's size/edge is
      // off-grid) by up to half a grid step, cutting its clearance below the gap so
      // the very next check drops it. Blank-canvas spots are snapped in centred().
      .map((c) => ({ point: c.point, size: c.size }))
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

  // A few spots centred on a point (empty canvas / blank viewport).
  const centred = (c: Point): Raw[] => {
    // On an empty/blank area, position is irrelevant — so offer the meaningful
    // choice instead: SIZE. Default (centred, ranks best), a larger option, and a
    // compact one. Grid-snapped at the source (finalize trusts incoming points as-is;
    // it no longer re-snaps, which would nudge guide-aligned packed spots off their
    // cleared positions), so the blank-canvas spots must arrive grid-aligned.
    const sized = (w: number, h: number): Size => ({
      width: Math.max(PLACEMENT_MIN_W, Math.min(PLACEMENT_MAX_W, snapScalar(w, grid))),
      height: Math.max(PLACEMENT_MIN_H, Math.min(PLACEMENT_MAX_H, snapScalar(h, grid))),
    })
    const def = std
    const large = sized(std.width * 1.4, std.height * 1.4)
    const compact = sized(std.width * 0.65, std.height * 0.65)
    const tl = snapPt({ x: c.x - def.width / 2, y: c.y - def.height / 2 })
    return [
      { point: tl, size: def },
      { point: snapPt({ x: tl.x + def.width + gap, y: tl.y }), size: large },
      { point: snapPt({ x: tl.x, y: tl.y + def.height + gap }), size: compact },
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
  // evaluates every free rectangle: it SIZES the ghost by mirroring an adjacent
  // neighbor's FULL size (both axes), else the panel default — clamped to MIN/MAX.
  // A rect too small to host that full size is SKIPPED (no fill, no slivers). It
  // then POSITIONS the ghost by snapping each edge to the nearest alignment guide
  // (else the grid) and clamping inside the rect. The rectangle whose result lands
  // closest to the ranking point wins; that ghost (plus its gap) is carved out of
  // the free space and the step repeats.
  // Because the nearest free space is always used first, no closer empty spot is
  // ever left unused — which is what keeps the result tight in irregular layouts.
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  const inflated = nodeRects.map((r) => inflateRect(r, gap))
  let free = freeRectangles(area, inflated)
  // Spots also mirror already-placed ghosts (not just real windows), so the
  // recommendations tile outward into a uniform grid. Grows as ghosts are placed.
  const obstacles: Rect[] = [...inflated]

  const guides = deriveGuides(nodes, gap)
  if (trace) {
    trace.area = area
    trace.rankAt = rankAt
    trace.inflated = inflated
    trace.guides = guides
  }

  const raw: Raw[] = []
  for (let n = 0; n < max && free.length > 0; n++) {
    const freeSnapshot = free.slice()
    let best:
      | { point: Point; size: Size; score: number; meta: PlacementTraceStep }
      | null = null
    for (const f of free) {
      const ix0 = Math.ceil(f.origin.x / grid) * grid
      const ix1 = Math.floor((f.origin.x + f.size.width) / grid) * grid
      const iy0 = Math.ceil(f.origin.y / grid) * grid
      const iy1 = Math.floor((f.origin.y + f.size.height) / grid) * grid
      const availW = ix1 - ix0, availH = iy1 - iy0
      if (availW < PLACEMENT_MIN_W || availH < PLACEMENT_MIN_H) continue

      // Balanced sizing: mirror a neighbor when it fits (uniform tiles), else
      // grow-to-fill a genuinely empty gap that is at least USEFUL_MIN in both
      // dimensions (so real gaps get used, thin slivers are skipped), else the
      // per-type default where no neighbor exists.
      const neighbor = matchedNeighborSize(f, obstacles, gap, rankAt)
      const mirrorFits =
        !!neighbor && availW >= neighbor.width - FIT_TOL && availH >= neighbor.height - FIT_TOL
      let targetW: number
      let targetH: number
      let filled = false
      if (mirrorFits) {
        // Clean uniform mirror tile (equals a real neighbor) — always offered.
        targetW = neighbor!.width
        targetH = neighbor!.height
      } else if (neighbor) {
        // Mirror does not fit: grow to fill the gap, but only if it's useful —
        // drop thin slivers.
        if (availW < USEFUL_MIN_W || availH < USEFUL_MIN_H) continue
        targetW = availW
        targetH = availH
        filled = true
      } else {
        // No neighbor at all → default size; skip if it doesn't fit.
        if (availW < std.width - FIT_TOL || availH < std.height - FIT_TOL) continue
        targetW = std.width
        targetH = std.height
      }
      const w = clamp(targetW, PLACEMENT_MIN_W, Math.min(PLACEMENT_MAX_W, availW))
      const h = clamp(targetH, PLACEMENT_MIN_H, Math.min(PLACEMENT_MAX_H, availH))

      // Aspect-ratio guard — grow-to-fill ONLY. A filled gap whose final clamped
      // shape strays too far from the panel's natural AR (a tall/narrow or
      // wide/flat tile) is skipped. Mirror and default tiles are exempt.
      if (filled) {
        const ar = w / h
        const defAR = std.width / std.height
        if (ar < defAR / FILL_AR_FACTOR || ar > defAR * FILL_AR_FACTOR) continue
      }

      const rawX = rankAt.x - w / 2
      const rawY = rankAt.y - h / 2
      const point = {
        x: clamp(snapAxis(rawX, w, guides.xs, SNAP_TOL, grid), ix0, ix1 - w),
        y: clamp(snapAxis(rawY, h, guides.ys, SNAP_TOL, grid), iy0, iy1 - h),
      }
      const score = Math.hypot(point.x + w / 2 - rankAt.x, point.y + h / 2 - rankAt.y)
      if (!best || score < best.score) {
        best = {
          point,
          size: { width: w, height: h },
          score,
          meta: {
            free: freeSnapshot,
            chosen: f,
            matchedWidth: mirrorFits ? neighbor!.width : null,
            matchedHeight: mirrorFits ? neighbor!.height : null,
            filled,
            size: { width: w, height: h },
            point,
          },
        }
      }
    }
    if (!best) break
    raw.push({ point: best.point, size: best.size })
    if (trace) trace.steps.push(best.meta)
    const placed = inflateRect({ origin: best.point, size: best.size }, gap)
    obstacles.push(placed)
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
