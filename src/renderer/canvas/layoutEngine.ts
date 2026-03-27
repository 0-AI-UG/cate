// =============================================================================
// Canvas Layout Engine — pure layout/snapping functions.
// Ported from CanvasLayoutEngine.swift.
// =============================================================================

import type { Point, Size, Rect, PanelType } from '../../shared/types'
import { PANEL_DEFAULT_SIZES, PANEL_MINIMUM_SIZES } from '../../shared/types'

// -----------------------------------------------------------------------------
// Grid snapping
// -----------------------------------------------------------------------------

/** Round a point to the nearest grid intersection. */
export function snapToGrid(point: Point, gridSize = 20): Point {
  return {
    x: Math.round(point.x / gridSize) * gridSize,
    y: Math.round(point.y / gridSize) * gridSize,
  }
}

/**
 * Snap a size so that the bottom-right corner lands on a grid line.
 * The resulting size is at least one gridSize unit in each dimension.
 */
export function snapSize(size: Size, origin: Point, gridSize = 20): Size {
  const bottomRight: Point = {
    x: origin.x + size.width,
    y: origin.y + size.height,
  }
  const snappedBR = snapToGrid(bottomRight, gridSize)
  return {
    width: Math.max(snappedBR.x - origin.x, gridSize),
    height: Math.max(snappedBR.y - origin.y, gridSize),
  }
}

// -----------------------------------------------------------------------------
// Edge snapping
// -----------------------------------------------------------------------------

/**
 * Snap a rect's origin to nearby edges of neighbor rects.
 * Returns `{ x, y }` where each axis is either the snapped value or null if
 * no neighbor edge was within threshold.
 */
export function snapToEdges(
  rect: Rect,
  neighbors: Rect[],
  threshold = 8,
): { x: number | null; y: number | null } {
  let snapX: number | null = null
  let snapY: number | null = null
  let bestDX = Infinity
  let bestDY = Infinity

  const rMinX = rect.origin.x
  const rMaxX = rect.origin.x + rect.size.width
  const rMinY = rect.origin.y
  const rMaxY = rect.origin.y + rect.size.height

  for (const neighbor of neighbors) {
    const nMinX = neighbor.origin.x
    const nMaxX = neighbor.origin.x + neighbor.size.width
    const nMinY = neighbor.origin.y
    const nMaxY = neighbor.origin.y + neighbor.size.height

    // X-axis candidates: (distance, snapped origin.x)
    const xCandidates: [number, number][] = [
      [Math.abs(rMinX - nMinX), nMinX],
      [Math.abs(rMinX - nMaxX), nMaxX],
      [Math.abs(rMaxX - nMinX), nMinX - rect.size.width],
      [Math.abs(rMaxX - nMaxX), nMaxX - rect.size.width],
    ]
    for (const [dist, snappedX] of xCandidates) {
      if (dist < threshold && dist < bestDX) {
        bestDX = dist
        snapX = snappedX
      }
    }

    // Y-axis candidates: (distance, snapped origin.y)
    const yCandidates: [number, number][] = [
      [Math.abs(rMinY - nMinY), nMinY],
      [Math.abs(rMinY - nMaxY), nMaxY],
      [Math.abs(rMaxY - nMinY), nMinY - rect.size.height],
      [Math.abs(rMaxY - nMaxY), nMaxY - rect.size.height],
    ]
    for (const [dist, snappedY] of yCandidates) {
      if (dist < threshold && dist < bestDY) {
        bestDY = dist
        snapY = snappedY
      }
    }
  }

  return { x: snapX, y: snapY }
}

// -----------------------------------------------------------------------------
// Combined snap (grid + edge, best wins per axis)
// -----------------------------------------------------------------------------

/**
 * Snap a rect using both grid and edge snapping.
 * For each axis, the snap source with the smaller distance wins.
 */
export function snap(
  rect: Rect,
  neighbors: Rect[],
  gridSize = 20,
  edgeThreshold = 8,
): Point {
  const gridOrigin = snapToGrid(rect.origin, gridSize)
  const gridRect: Rect = { origin: gridOrigin, size: rect.size }
  const edgeResult = snapToEdges(gridRect, neighbors, edgeThreshold)

  // For each axis, pick the snap with the smaller displacement from the original
  let x = gridOrigin.x
  if (edgeResult.x !== null) {
    const edgeDist = Math.abs(edgeResult.x - rect.origin.x)
    const gridDist = Math.abs(gridOrigin.x - rect.origin.x)
    if (edgeDist < gridDist) {
      x = edgeResult.x
    }
  }

  let y = gridOrigin.y
  if (edgeResult.y !== null) {
    const edgeDist = Math.abs(edgeResult.y - rect.origin.y)
    const gridDist = Math.abs(gridOrigin.y - rect.origin.y)
    if (edgeDist < gridDist) {
      y = edgeResult.y
    }
  }

  return { x, y }
}

// -----------------------------------------------------------------------------
// Free position search
// -----------------------------------------------------------------------------

/**
 * Find a non-overlapping position near `near` for a new panel.
 * If `near` is null or there are no existing rects, returns a default position.
 */
export function findFreePosition(
  near: Point | null,
  existingRects: Rect[],
  panelType: PanelType,
  gridSize = 20,
): Point {
  if (existingRects.length === 0) {
    return { x: 100, y: 100 }
  }

  // If no reference point, use the last existing rect's origin
  const size = defaultSize(panelType)
  const gap = gridSize

  // Find the nearest existing rect to the reference point
  let nearestRect: Rect
  if (near != null) {
    nearestRect = existingRects.reduce((closest, r) => {
      const distCurrent = Math.hypot(
        r.origin.x - near.x,
        r.origin.y - near.y,
      )
      const distClosest = Math.hypot(
        closest.origin.x - near.x,
        closest.origin.y - near.y,
      )
      return distCurrent < distClosest ? r : closest
    })
  } else {
    nearestRect = existingRects[existingRects.length - 1]
  }

  // Try right of nearest rect
  const rightCandidate: Point = {
    x: nearestRect.origin.x + nearestRect.size.width + gap,
    y: nearestRect.origin.y,
  }
  const rightRect: Rect = { origin: rightCandidate, size }
  if (!existingRects.some((r) => rectsOverlap(r, rightRect))) {
    return snapToGrid(rightCandidate, gridSize)
  }

  // Try below nearest rect
  const belowCandidate: Point = {
    x: nearestRect.origin.x,
    y: nearestRect.origin.y + nearestRect.size.height + gap,
  }
  const belowRect: Rect = { origin: belowCandidate, size }
  if (!existingRects.some((r) => rectsOverlap(r, belowRect))) {
    return snapToGrid(belowCandidate, gridSize)
  }

  // Scan 50 positions rightward
  for (let i = 1; i <= 50; i++) {
    const scanCandidate: Point = {
      x: nearestRect.origin.x + nearestRect.size.width + gap + 100 * i,
      y: nearestRect.origin.y,
    }
    const scanRect: Rect = { origin: scanCandidate, size }
    if (!existingRects.some((r) => rectsOverlap(r, scanRect))) {
      return snapToGrid(scanCandidate, gridSize)
    }
  }

  // Fallback: offset from nearest
  return snapToGrid(
    {
      x: nearestRect.origin.x + nearestRect.size.width + gap,
      y: nearestRect.origin.y + gap,
    },
    gridSize,
  )
}

// -----------------------------------------------------------------------------
// Panel size helpers
// -----------------------------------------------------------------------------

/** Default size for a given panel type. */
export function defaultSize(panelType: PanelType): Size {
  return PANEL_DEFAULT_SIZES[panelType]
}

/** Minimum size for a given panel type. */
export function minimumSize(panelType: PanelType): Size {
  return PANEL_MINIMUM_SIZES[panelType]
}

// -----------------------------------------------------------------------------
// Auto layout
// -----------------------------------------------------------------------------

/**
 * Compute a grid layout for a set of nodes.
 * Returns a map of nodeId → new origin.
 */
export function autoLayout(
  nodes: { id: string; size: Size }[],
  containerWidth: number,
  gap = 40,
): Record<string, Point> {
  const result: Record<string, Point> = {}
  let x = gap
  let y = gap
  let rowHeight = 0

  for (const node of nodes) {
    // Wrap to next row if exceeding container width
    if (x + node.size.width + gap > containerWidth && x > gap) {
      x = gap
      y += rowHeight + gap
      rowHeight = 0
    }

    result[node.id] = { x, y }
    x += node.size.width + gap
    rowHeight = Math.max(rowHeight, node.size.height)
  }

  return result
}

// -----------------------------------------------------------------------------
// Overlap detection
// -----------------------------------------------------------------------------

/** Axis-aligned rectangle overlap check. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(
    a.origin.x + a.size.width <= b.origin.x ||
    b.origin.x + b.size.width <= a.origin.x ||
    a.origin.y + a.size.height <= b.origin.y ||
    b.origin.y + b.size.height <= a.origin.y
  )
}
