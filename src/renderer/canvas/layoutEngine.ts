// =============================================================================
// Canvas Layout Engine — pure layout/snapping functions.
// Ported from CanvasLayoutEngine.swift.
// =============================================================================

import type {
  Point,
  Size,
  PanelType,
  CanvasNodeState,
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
