// =============================================================================
// dragGeometry — pure helpers for cursor/grab/ghost math during a drag op.
// Single source of truth for canvas-space ↔ screen-space conversions while
// dragging. Used by useDragOp, resolveDrop, and DragOverlay.
// =============================================================================

import type { Point, Size } from '../../shared/types'
import { viewToCanvas } from '../lib/coordinates'

/**
 * Cursor → canvas-space origin for the dropped/repositioned node.
 *
 * `grab` is the canvas-space offset from the node's top-left to the grab point.
 * `cursor.client` is in window client coordinates. We subtract the canvas
 * container's client-rect to localize, then convert to canvas-space using the
 * target canvas's zoom + viewport offset.
 */
export function cursorToCanvasOrigin(
  cursor: { client: Point },
  canvasContainerRect: DOMRect,
  zoom: number,
  viewportOffset: Point,
  grab: Point,
): Point {
  const localView: Point = {
    x: cursor.client.x - canvasContainerRect.left,
    y: cursor.client.y - canvasContainerRect.top,
  }
  const cursorCanvas = viewToCanvas(localView, zoom, viewportOffset)
  return {
    x: cursorCanvas.x - grab.x,
    y: cursorCanvas.y - grab.y,
  }
}

/**
 * Screen-px top-left of the ghost so the cursor sits at the same relative
 * point inside the ghost as the user grabbed in the source.
 *
 * `ghostSize` is canvas-space; we multiply by zoom for screen-px dimensions.
 */
export function ghostScreenRect(
  cursor: Point,
  grab: Point,
  ghostSize: Size,
  zoom: number,
): { left: number; top: number; width: number; height: number } {
  const width = ghostSize.width * zoom
  const height = ghostSize.height * zoom
  return {
    left: cursor.x - grab.x * zoom,
    top: cursor.y - grab.y * zoom,
    width,
    height,
  }
}

/**
 * Normalize a grab offset captured from a screen-px cursor inside a source
 * element's bounding rect into canvas-space (using the source's canvas zoom).
 * Used at drag start.
 */
export function normalizeGrabOffset(
  cursorClient: Point,
  sourceRect: DOMRect,
  sourceZoom: number,
): Point {
  const safeZoom = Number.isFinite(sourceZoom) && sourceZoom > 0.01 ? sourceZoom : 1
  return {
    x: (cursorClient.x - sourceRect.left) / safeZoom,
    y: (cursorClient.y - sourceRect.top) / safeZoom,
  }
}
