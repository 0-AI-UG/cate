// Canvas geometry: points, sizes, rects, grid snapping and the node-level
// geometry queries (shared borders, directional neighbours) that are model
// logic rather than view logic.

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect {
  origin: Point
  size: Size
}

/** Anything with an id and a canvas-space rect: a canvas node, or a node-like
 *  box a caller builds for a query. */
export interface Box {
  id: string
  rect: Rect
}

/** Canvas-space spacing of the snap and background grid. Auto-placement and
 *  snap-to-grid use it so snapped panels land on the lines the user sees. */
export const CANVAS_GRID_SIZE = 20

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { origin: { x, y }, size: { width, height } }
}

export function rectCenter(r: Rect): Point {
  return { x: r.origin.x + r.size.width / 2, y: r.origin.y + r.size.height / 2 }
}

export function isFiniteRect(r: Rect): boolean {
  return [r.origin.x, r.origin.y, r.size.width, r.size.height].every(Number.isFinite)
    && r.size.width > 0 && r.size.height > 0
}

export function sameRect(a: Rect, b: Rect): boolean {
  return a.origin.x === b.origin.x && a.origin.y === b.origin.y
    && a.size.width === b.size.width && a.size.height === b.size.height
}

/** Axis-aligned overlap test; touching edges do not overlap. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(
    a.origin.x + a.size.width <= b.origin.x ||
    b.origin.x + b.size.width <= a.origin.x ||
    a.origin.y + a.size.height <= b.origin.y ||
    b.origin.y + b.size.height <= a.origin.y
  )
}

/** Grow a rect by `m` on every side. */
export function inflateRect(r: Rect, m: number): Rect {
  return {
    origin: { x: r.origin.x - m, y: r.origin.y - m },
    size: { width: r.size.width + m * 2, height: r.size.height + m * 2 },
  }
}

/** True when `inner` lies within `outer` (half a unit of tolerance). */
export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.origin.x >= outer.origin.x - 0.5 &&
    inner.origin.y >= outer.origin.y - 0.5 &&
    inner.origin.x + inner.size.width <= outer.origin.x + outer.size.width + 0.5 &&
    inner.origin.y + inner.size.height <= outer.origin.y + outer.size.height + 0.5
  )
}

/** The smallest rect holding every rect, or null for none. */
export function boundingRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.origin.x)
    minY = Math.min(minY, r.origin.y)
    maxX = Math.max(maxX, r.origin.x + r.size.width)
    maxY = Math.max(maxY, r.origin.y + r.size.height)
  }
  return rect(minX, minY, maxX - minX, maxY - minY)
}

/** view = canvas * zoom + offset */
export function canvasToView(point: Point, zoom: number, offset: Point): Point {
  return { x: point.x * zoom + offset.x, y: point.y * zoom + offset.y }
}

/** canvas = (view - offset) / zoom. A zero or corrupt zoom is floored so it
 *  cannot turn every coordinate into NaN. */
export function viewToCanvas(point: Point, zoom: number, offset: Point): Point {
  const safeZoom = Number.isFinite(zoom) && zoom > 0.01 ? zoom : 0.01
  return { x: (point.x - offset.x) / safeZoom, y: (point.y - offset.y) / safeZoom }
}

// --- Grid snapping -----------------------------------------------------------

/** Round to the nearest grid multiple, optionally floored at one grid step
 *  (where a snapped size must stay positive). */
export function snapScalar(v: number, grid: number, floorAtGrid = false): number {
  const snapped = Math.round(v / grid) * grid
  return floorAtGrid ? Math.max(grid, snapped) : snapped
}

export function snapToGrid(point: Point, gridSize = CANVAS_GRID_SIZE): Point {
  return {
    x: Math.round(point.x / gridSize) * gridSize,
    y: Math.round(point.y / gridSize) * gridSize,
  }
}

/** Which edges a resize gesture moves: one flag for a side, two for a corner. */
export interface MovingEdges {
  left: boolean
  right: boolean
  top: boolean
  bottom: boolean
}

/** Adjust a resize delta so the moving edges land on grid lines while the
 *  opposite edges stay put. Snapping the delta, not the final rect, keeps the
 *  shared-border neighbour math (derived from the same delta) consistent. */
export function snapResizeDelta(
  moving: MovingEdges,
  startOrigin: Point,
  startSize: Size,
  delta: Point,
  gridSize = CANVAS_GRID_SIZE,
): Point {
  let dx = delta.x
  let dy = delta.y
  const round = (v: number) => Math.round(v / gridSize) * gridSize

  if (moving.right) {
    const right = startOrigin.x + startSize.width + dx
    dx = round(right) - (startOrigin.x + startSize.width)
  } else if (moving.left) {
    dx = round(startOrigin.x + dx) - startOrigin.x
  }

  if (moving.bottom) {
    const bottom = startOrigin.y + startSize.height + dy
    dy = round(bottom) - (startOrigin.y + startSize.height)
  } else if (moving.top) {
    dy = round(startOrigin.y + dy) - startOrigin.y
  }

  return { x: dx, y: dy }
}

// --- Node queries --------------------------------------------------------------

export type Edge = 'left' | 'right' | 'top' | 'bottom'

export interface SharedBorder {
  neighborId: string
  /** The neighbour's edge that touches the moving edge. */
  neighborEdge: Edge
}

/** Nodes whose opposite edge lines up with `edge` of `nodeId` (within
 *  `tolerance`) and that overlap it along that edge, so a resize can move both. */
export function findSharedBorders(
  nodeId: string,
  edge: Edge,
  nodes: Readonly<Record<string, Box>>,
  tolerance = 2,
): SharedBorder[] {
  const node = nodes[nodeId]
  if (!node) return []
  const { origin, size } = node.rect
  const results: SharedBorder[] = []
  const isHorizontal = edge === 'left' || edge === 'right'

  const edgePos =
    edge === 'right' ? origin.x + size.width
    : edge === 'left' ? origin.x
    : edge === 'bottom' ? origin.y + size.height
    : origin.y

  const oppositeEdge: Edge =
    edge === 'right' ? 'left' : edge === 'left' ? 'right' : edge === 'bottom' ? 'top' : 'bottom'

  for (const other of Object.values(nodes)) {
    if (other.id === nodeId) continue
    const o = other.rect
    const neighborEdgePos =
      oppositeEdge === 'left' ? o.origin.x
      : oppositeEdge === 'right' ? o.origin.x + o.size.width
      : oppositeEdge === 'top' ? o.origin.y
      : o.origin.y + o.size.height
    if (Math.abs(edgePos - neighborEdgePos) > tolerance) continue

    const overlap = isHorizontal
      ? Math.min(origin.y + size.height, o.origin.y + o.size.height) - Math.max(origin.y, o.origin.y)
      : Math.min(origin.x + size.width, o.origin.x + o.size.width) - Math.max(origin.x, o.origin.x)
    if (overlap <= 0) continue

    results.push({ neighborId: other.id, neighborEdge: oppositeEdge })
  }
  return results
}

export type Direction = 'up' | 'down' | 'left' | 'right'

/** The nearest node in a direction from a reference point. The candidate must
 *  lie in the half-plane and the move axis must dominate, so a node that is
 *  mostly sideways is never picked. */
export function findNodeInDirection<T extends Box>(
  nodes: readonly T[],
  from: Point,
  dir: Direction,
  excludeId?: string,
): T | null {
  let best: T | null = null
  let bestScore = Infinity
  for (const n of nodes) {
    if (excludeId && n.id === excludeId) continue
    const c = rectCenter(n.rect)
    const dx = c.x - from.x
    const dy = c.y - from.y
    const adx = Math.abs(dx)
    const ady = Math.abs(dy)

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
  return best
}
