import type { Point, Size } from '../../shared/types'

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
