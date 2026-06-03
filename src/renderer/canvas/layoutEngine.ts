// =============================================================================
// Canvas Layout Engine — pure layout/snapping functions.
// Ported from CanvasLayoutEngine.swift.
// =============================================================================

import type {
  Point,
  Size,
  PanelType,
  CanvasNodeState,
  CanvasRegion,
} from '../../shared/types'
import { PANEL_MINIMUM_SIZES } from '../../shared/types'

// -----------------------------------------------------------------------------
// Grid snapping
// -----------------------------------------------------------------------------

/** Canvas-space spacing of the snap/background grid, in canvas units. Shared by
 *  the visual grid (CanvasGrid), auto-placement, and the snap-to-grid feature so
 *  snapped panels line up with the dots/lines the user actually sees. */
export const CANVAS_GRID_SIZE = 20

/** Round a point to the nearest grid intersection. */
export function snapToGrid(point: Point, gridSize = CANVAS_GRID_SIZE): Point {
  return {
    x: Math.round(point.x / gridSize) * gridSize,
    y: Math.round(point.y / gridSize) * gridSize,
  }
}

/** Which edges a resize gesture is moving. Cardinal edges set one flag; corners
 *  set one horizontal and one vertical flag. */
export interface MovingEdges {
  left: boolean
  right: boolean
  top: boolean
  bottom: boolean
}

/**
 * Adjust a resize delta so the moving edge(s) land on the nearest grid line,
 * keeping the opposite (fixed) edge put. Pure counterpart to the geometry in
 * useNodeResize — snapping the delta (rather than the final rect) lets the
 * shared-border neighbor math, which is derived from the same delta, stay
 * consistent with the primary node.
 */
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

// -----------------------------------------------------------------------------
// Panel size helpers
// -----------------------------------------------------------------------------

/** Minimum size for a given panel type. */
export function minimumSize(panelType: PanelType): Size {
  return PANEL_MINIMUM_SIZES[panelType]
}

// -----------------------------------------------------------------------------
// Auto layout (whole canvas: nodes + regions)
// -----------------------------------------------------------------------------

export interface AutoLayoutAllInput {
  nodes: CanvasNodeState[]
  regions: CanvasRegion[]
  containerWidth: number
  containerHeight?: number
  gap?: number
}

/**
 * Choose a target row-wrap width that produces a bbox close to the
 * container's aspect ratio. Falls back to ≈ √(totalArea) (square) when the
 * aspect ratio is unknown. Always at least as wide as the widest single item.
 */
function chooseTargetWidth(
  items: { size: Size }[],
  gap: number,
  aspect: number,
): number {
  if (items.length === 0) return 0
  const widest = items.reduce((m, it) => Math.max(m, it.size.width), 0)
  // Total area with gap padding baked in so wrap math stays stable.
  const totalArea = items.reduce(
    (s, it) => s + (it.size.width + gap) * (it.size.height + gap),
    0,
  )
  // width = sqrt(area * aspect)  ⇒  bbox ≈ container aspect
  const ideal = Math.sqrt(Math.max(totalArea, 1) * Math.max(aspect, 0.25))
  return Math.max(widest, ideal)
}

export interface AutoLayoutAllResult {
  nodeOrigins: Record<string, Point>
  regionOrigins: Record<string, Point>
  regionSizes: Record<string, Size>
}

/**
 * Layout everything on the canvas in a tidy row-wrap grid.
 *
 *  - Nodes contained in a region are grid-packed inside that region; the
 *    region is resized to fit them (with padding + a title-bar allowance).
 *  - Free nodes (no region) and regions (as super-items) are then packed
 *    together into a top-level row-wrap grid.
 *  - Existing item sizes are preserved — this only sorts & aligns.
 *
 * Ordering is stable: items are ranked by `creationIndex` (nodes) or by the
 * minimum `creationIndex` of their contents (regions).
 */
export function autoLayoutAll(input: AutoLayoutAllInput): AutoLayoutAllResult {
  const { nodes, regions, containerWidth } = input
  const containerHeight = input.containerHeight ?? Math.round(containerWidth * 0.625)
  const gap = input.gap ?? 40
  const regionPad = 24
  const regionTitleBar = 32
  // Aim each packed cluster at the viewport's aspect so the result looks
  // balanced rather than a tall column. Clamp to sensible bounds.
  const aspect = Math.max(0.6, Math.min(2.4, containerWidth / Math.max(containerHeight, 1)))

  const result: AutoLayoutAllResult = {
    nodeOrigins: {},
    regionOrigins: {},
    regionSizes: {},
  }

  // ---- Partition nodes by region --------------------------------------------
  const nodesByRegion = new Map<string, CanvasNodeState[]>()
  const freeNodes: CanvasNodeState[] = []
  for (const n of nodes) {
    if (n.regionId && regions.some((r) => r.id === n.regionId)) {
      const list = nodesByRegion.get(n.regionId) ?? []
      list.push(n)
      nodesByRegion.set(n.regionId, list)
    } else {
      freeNodes.push(n)
    }
  }

  // ---- Internal grid packer (row-wrap) --------------------------------------
  // Lays items starting at (0,0) relative, returns per-id origin + bbox.
  function packRelative(items: { id: string; size: Size }[], maxWidth: number) {
    const origins: Record<string, Point> = {}
    if (items.length === 0) return { origins, width: 0, height: 0 }

    // Masonry: equal-width columns (sized to the widest item) with each
    // item dropped into the currently shortest column. This keeps vertical
    // gaps tight regardless of item height variance.
    const colWidth = items.reduce((m, it) => Math.max(m, it.size.width), 0)
    const colCount = Math.max(
      1,
      Math.floor((maxWidth + gap) / (colWidth + gap)),
    )
    const colY: number[] = new Array(colCount).fill(0)
    let bboxW = 0
    let bboxH = 0

    for (const it of items) {
      // Pick shortest column (tie-break: leftmost).
      let col = 0
      for (let i = 1; i < colCount; i++) {
        if (colY[i] < colY[col]) col = i
      }
      const x = col * (colWidth + gap)
      const y = colY[col]
      origins[it.id] = { x, y }
      colY[col] = y + it.size.height + gap
      bboxW = Math.max(bboxW, x + it.size.width)
      bboxH = Math.max(bboxH, colY[col] - gap)
    }
    return { origins, width: bboxW, height: bboxH }
  }

  // ---- Precompute each region's internal layout + final size ---------------
  // Region's internal max-width is bounded by its current width, but grows if
  // the contained nodes don't fit.
  const regionInternal = new Map<
    string,
    { origins: Record<string, Point>; width: number; height: number }
  >()
  for (const region of regions) {
    const contained = (nodesByRegion.get(region.id) ?? []).slice().sort(
      (a, b) => a.creationIndex - b.creationIndex,
    )
    if (contained.length === 0) {
      regionInternal.set(region.id, { origins: {}, width: 0, height: 0 })
      continue
    }
    // Target a square-ish cluster for the region's contents rather than
    // forcing them into the region's pre-existing (often narrow) width.
    const items = contained.map((n) => ({ id: n.id, size: n.size }))
    const target = chooseTargetWidth(items, gap, 1.0)
    const packed = packRelative(items, target)
    regionInternal.set(region.id, packed)
  }

  // ---- Build top-level super-items ------------------------------------------
  type SuperItem =
    | { kind: 'node'; id: string; size: Size; rank: number }
    | { kind: 'region'; id: string; size: Size; rank: number }

  const supers: SuperItem[] = []

  for (const n of freeNodes) {
    supers.push({
      kind: 'node',
      id: n.id,
      size: n.size,
      rank: n.creationIndex,
    })
  }

  for (const region of regions) {
    const internal = regionInternal.get(region.id)!
    const contained = nodesByRegion.get(region.id) ?? []
    const minRank = contained.length > 0
      ? Math.min(...contained.map((n) => n.creationIndex))
      : Number.MAX_SAFE_INTEGER - 1
    const width = Math.max(
      region.size.width,
      internal.width + regionPad * 2,
      240,
    )
    const height = Math.max(
      internal.height + regionPad * 2 + regionTitleBar,
      120,
    )
    supers.push({
      kind: 'region',
      id: region.id,
      size: { width, height },
      rank: minRank,
    })
    result.regionSizes[region.id] = { width, height }
  }

  supers.sort((a, b) => a.rank - b.rank)

  // ---- Pack super-items into a balanced grid -------------------------------
  // Target width matches the viewport's aspect so the overall layout looks
  // like a nice rectangular bulk rather than a tall stripe. The container
  // width is only used as an upper bound so the result still fits on screen
  // when possible.
  const topItems = supers.map((s) => ({ id: s.kind + ':' + s.id, size: s.size }))
  const idealTopWidth = chooseTargetWidth(topItems, gap, aspect)
  const topMaxW = Math.max(
    // Never narrower than the widest single super-item.
    topItems.reduce((m, it) => Math.max(m, it.size.width), 0),
    Math.min(idealTopWidth, Math.max(containerWidth - gap * 2, idealTopWidth)),
  )
  const topPacked = packRelative(topItems, topMaxW)

  const originFor = (kind: string, id: string) =>
    topPacked.origins[kind + ':' + id]

  const baseX = gap
  const baseY = gap

  for (const s of supers) {
    const rel = originFor(s.kind, s.id)
    const abs: Point = { x: baseX + rel.x, y: baseY + rel.y }
    if (s.kind === 'node') {
      result.nodeOrigins[s.id] = abs
    } else {
      result.regionOrigins[s.id] = abs
      // Place contained nodes relative to region's inner content area.
      const internal = regionInternal.get(s.id)!
      const innerX = abs.x + regionPad
      const innerY = abs.y + regionPad + regionTitleBar
      for (const [nodeId, rel2] of Object.entries(internal.origins)) {
        result.nodeOrigins[nodeId] = {
          x: innerX + rel2.x,
          y: innerY + rel2.y,
        }
      }
    }
  }

  return result
}

// -----------------------------------------------------------------------------
// Shared border detection (for synchronized resize)
// -----------------------------------------------------------------------------

export interface SharedBorder {
  neighborId: string
  /** Which edge of the neighbor is shared. */
  neighborEdge: 'left' | 'right' | 'top' | 'bottom'
}

/**
 * Find nodes whose edge aligns with the given node's edge (shared border).
 * Only checks the opposite edge (e.g., if resizing `right`, looks for neighbors
 * whose `left` edge aligns). Also verifies perpendicular overlap so only
 * actually adjacent panels are returned.
 */
export function findSharedBorders(
  nodeId: string,
  edge: 'left' | 'right' | 'top' | 'bottom',
  nodes: Record<string, CanvasNodeState>,
  tolerance = 2,
): SharedBorder[] {
  const node = nodes[nodeId]
  if (!node) return []

  const results: SharedBorder[] = []

  // Determine which edge position to match and the opposite edge to look for
  const isHorizontal = edge === 'left' || edge === 'right'

  let edgePos: number
  if (edge === 'right') edgePos = node.origin.x + node.size.width
  else if (edge === 'left') edgePos = node.origin.x
  else if (edge === 'bottom') edgePos = node.origin.y + node.size.height
  else edgePos = node.origin.y // top

  const oppositeEdge: 'left' | 'right' | 'top' | 'bottom' =
    edge === 'right' ? 'left' : edge === 'left' ? 'right' : edge === 'bottom' ? 'top' : 'bottom'

  for (const other of Object.values(nodes)) {
    if (other.id === nodeId) continue

    // Get the neighbor's opposite edge position
    let neighborEdgePos: number
    if (oppositeEdge === 'left') neighborEdgePos = other.origin.x
    else if (oppositeEdge === 'right') neighborEdgePos = other.origin.x + other.size.width
    else if (oppositeEdge === 'top') neighborEdgePos = other.origin.y
    else neighborEdgePos = other.origin.y + other.size.height

    // Check alignment within tolerance
    if (Math.abs(edgePos - neighborEdgePos) > tolerance) continue

    // Check perpendicular overlap (panels must actually share a border segment)
    if (isHorizontal) {
      const overlapStart = Math.max(node.origin.y, other.origin.y)
      const overlapEnd = Math.min(
        node.origin.y + node.size.height,
        other.origin.y + other.size.height,
      )
      if (overlapEnd <= overlapStart) continue
    } else {
      const overlapStart = Math.max(node.origin.x, other.origin.x)
      const overlapEnd = Math.min(
        node.origin.x + node.size.width,
        other.origin.x + other.size.width,
      )
      if (overlapEnd <= overlapStart) continue
    }

    results.push({ neighborId: other.id, neighborEdge: oppositeEdge })
  }

  return results
}
