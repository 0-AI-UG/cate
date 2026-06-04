// =============================================================================
// Coordinate transforms — pure functions for canvas ↔ view conversions.
// Ported from CanvasState.swift canvasToView / viewToCanvas.
// =============================================================================

import type { Point, Size } from '../../../shared/types'

/**
 * Convert a point from canvas-space to view-space.
 *
 *   viewPoint = canvasPoint * zoom + offset
 */
export function canvasToView(point: Point, zoom: number, offset: Point): Point {
  return {
    x: point.x * zoom + offset.x,
    y: point.y * zoom + offset.y,
  }
}

/**
 * Convert a point from view-space to canvas-space.
 *
 *   canvasPoint = (viewPoint - offset) / zoom
 */
export function viewToCanvas(point: Point, zoom: number, offset: Point): Point {
  // Guard against zero/NaN zoom — corrupt zoom would propagate NaN through
  // every node origin and break the canvas. Floor at 0.01.
  const safeZoom = Number.isFinite(zoom) && zoom > 0.01 ? zoom : 0.01
  return {
    x: (point.x - offset.x) / safeZoom,
    y: (point.y - offset.y) / safeZoom,
  }
}

/**
 * Compute the view-space bounding rectangle for a canvas node.
 */
export function viewFrame(
  node: { origin: Point; size: Size },
  zoom: number,
  offset: Point,
): { x: number; y: number; width: number; height: number } {
  const viewOrigin = canvasToView(node.origin, zoom, offset)
  return {
    x: viewOrigin.x,
    y: viewOrigin.y,
    width: node.size.width * zoom,
    height: node.size.height * zoom,
  }
}
