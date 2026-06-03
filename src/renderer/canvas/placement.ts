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
 * Maximal empty rectangles inside `region` that no node covers (coordinate
 * compression over node edges → free-cell grid → maximal free rectangles). This
 * finds the actual holes in a layout — including the irregular ones a staggered
 * arrangement produces, not just gaps between two aligned nodes.
 */
function findEmptyRects(region: Rect, nodeRects: Rect[]): Rect[] {
  const rx0 = region.origin.x, ry0 = region.origin.y
  const rx1 = rx0 + region.size.width, ry1 = ry0 + region.size.height
  const xs = new Set<number>([rx0, rx1])
  const ys = new Set<number>([ry0, ry1])
  for (const n of nodeRects) {
    for (const x of [n.origin.x, n.origin.x + n.size.width]) if (x > rx0 && x < rx1) xs.add(x)
    for (const y of [n.origin.y, n.origin.y + n.size.height]) if (y > ry0 && y < ry1) ys.add(y)
  }
  const X = [...xs].sort((a, b) => a - b)
  const Y = [...ys].sort((a, b) => a - b)
  const cols = X.length - 1, rows = Y.length - 1
  if (cols <= 0 || rows <= 0) return []
  const occ: boolean[][] = []
  for (let r = 0; r < rows; r++) {
    occ[r] = []
    const cy = (Y[r] + Y[r + 1]) / 2
    for (let c = 0; c < cols; c++) {
      const cx = (X[c] + X[c + 1]) / 2
      occ[r][c] = nodeRects.some((n) =>
        cx > n.origin.x && cx < n.origin.x + n.size.width && cy > n.origin.y && cy < n.origin.y + n.size.height)
    }
  }
  const rects: Rect[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (occ[r][c]) continue
      let limit = c
      while (limit + 1 < cols && !occ[r][limit + 1]) limit++
      for (let r2 = r; r2 < rows; r2++) {
        if (occ[r2][c]) break
        let rl = c
        while (rl + 1 <= limit && !occ[r2][rl + 1]) rl++
        limit = rl
        rects.push({ origin: { x: X[c], y: Y[r] }, size: { width: X[limit + 1] - X[c], height: Y[r2 + 1] - Y[r] } })
      }
    }
  }
  const area = (a: Rect) => a.size.width * a.size.height
  const contains = (b: Rect, a: Rect) =>
    b.origin.x <= a.origin.x && b.origin.y <= a.origin.y &&
    b.origin.x + b.size.width >= a.origin.x + a.size.width &&
    b.origin.y + b.size.height >= a.origin.y + a.size.height
  // Keep only the maximal rectangles (drop ones contained in a bigger sibling).
  return rects.filter((a, i) => !rects.some((b, j) =>
    i !== j && contains(b, a) && (area(b) > area(a) || (area(b) === area(a) && j < i))))
}

/**
 * Size a panel to FILL each maximal empty rectangle inside the cluster's bounds,
 * within the placement bounds (min/max + aspect ratio). A candidate is emitted
 * only when its size differs meaningfully from the reference `ref` — otherwise an
 * ordinary reference-sized spot already covers the hole. This gives individually
 * sized ghosts for the irregular gaps a layout leaves behind.
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
  for (const er of findEmptyRects(boundsOf(cluster), allNodeRects)) {
    const availW = er.size.width - 2 * gap
    const availH = er.size.height - 2 * gap
    if (availW < PLACEMENT_MIN_W || availH < PLACEMENT_MIN_H) continue
    const s = clampPlacementSize(availW, availH, grid)
    if (Math.abs(s.width - ref.width) <= 2 * gap && Math.abs(s.height - ref.height) <= 2 * gap) continue
    const rect: Rect = {
      origin: { x: er.origin.x + gap + (availW - s.width) / 2, y: er.origin.y + gap + (availH - s.height) / 2 },
      size: s,
    }
    if (fits(rect)) out.push(rect)
  }
  return out
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
  // Recommendations use the standard panel size; only gap-fill candidates take a
  // custom size (to fit an irregular hole).
  const size = baseSize

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

  // Gap-fill: holes around the focus (active node, else the target island) get
  // an individually-sized recommendation that fills the hole. We look at the
  // focus plus every node within ~2 panels of it — wider than the clustering
  // threshold — so a big gap between two far-apart nodes is filled too.
  const focusRect: Rect | null = activeNode
    ? { origin: activeNode.origin, size: activeNode.size }
    : target ? boundsOf(target) : null
  if (focusRect) {
    const nearMax = Math.max(baseSize.width, baseSize.height) * 2
    const gapNodes = nodeList.filter((n) => rectGap(focusRect, { origin: n.origin, size: n.size }) <= nearMax)
    if (gapNodes.length >= 2) {
      for (const r of gapFillCandidates(gapNodes, size, gap, grid, nodeRects)) {
        cands.push({ point: snapPt(r.origin), size: r.size, custom: true })
      }
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
      // A gap-filler only exists where a reference-sized spot fits the hole
      // poorly, so it should WIN that hole over the overlapping standard spot —
      // a small preference does this without letting customs dominate globally.
      return { rect, custom: c.custom, point: c.point, size: c.size, onScreen, score: (onScreen ? 0 : 1e9) + dist - (c.custom ? 120 : 0) }
    })
    .sort((a, b) => a.score - b.score)

  const accepted: PlacementCandidate[] = []
  const acceptedRects: Rect[] = []
  const maxCustom = Math.max(1, Math.floor(cap / 2)) // keep room for standard spots
  let customCount = 0
  for (const c of ranked) {
    if (accepted.length >= cap) break
    if (c.custom && customCount >= maxCustom) continue
    if (!clearRect(c.rect, nodeRects)) continue
    if (!clearRect(c.rect, acceptedRects)) continue
    acceptedRects.push(c.rect)
    if (c.custom) customCount++
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
