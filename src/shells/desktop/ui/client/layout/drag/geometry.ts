// Pure cursor, grab and ghost math for a drag.

import { canvasToView, viewToCanvas, type Point, type Size } from '@workspace/canvas/contract'
import type { GhostRect } from './types'

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
  canvasContainerRect: { left: number; top: number },
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
): GhostRect {
  const width = ghostSize.width * zoom
  const height = ghostSize.height * zoom
  return {
    left: cursor.x - grab.x * zoom,
    top: cursor.y - grab.y * zoom,
    width,
    height,
  }
}

/** Grab offset for a dock-tab source whose tab strip is much smaller than
 *  the ghost. The cursor's literal offset from the tab's top-left is
 *  preserved (no proportional scaling), so the ghost is anchored near the
 *  top-left where the drag-handle/tab-strip sits. Clamped to the ghost's
 *  width and to the source rect's height so a cursor at the bottom of the
 *  tab strip doesn't end up below the tab area inside the ghost. */
export function dockTabGrabOffset(args: {
  cursorClient: Point
  sourceRect: { left: number; top: number; width: number; height: number }
  ghostSize: Size
}): Point {
  const offsetX = args.cursorClient.x - args.sourceRect.left
  const offsetY = args.cursorClient.y - args.sourceRect.top
  return {
    x: Math.max(0, Math.min(offsetX, args.ghostSize.width)),
    y: Math.max(0, Math.min(offsetY, args.sourceRect.height)),
  }
}

/** Screen-px rect of a canvas-space origin and size on a canvas container:
 *  the snapped landing cell a snap-to-grid drag previews. */
export function snappedGhostScreenRect(
  origin: Point,
  containerRect: { left: number; top: number },
  zoom: number,
  viewportOffset: Point,
  ghostSize: Size,
): GhostRect {
  const view = canvasToView(origin, zoom, viewportOffset)
  return {
    left: containerRect.left + view.x,
    top: containerRect.top + view.y,
    width: ghostSize.width * zoom,
    height: ghostSize.height * zoom,
  }
}
