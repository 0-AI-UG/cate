// Drop targets the views register: dock stacks and window edges, and canvas
// surfaces. Hit testing reads them on every move.

import type { Point } from '@workspace/canvas/contract'
import type { DockRef, SplitSide, StackId } from '@workspace/document/contract'

export interface DropZoneEntry {
  id: string
  workspaceId: string
  dock: DockRef
  /** A stack: tab bar and edges. */
  stackId?: StackId
  /** A window edge strip: dropping splits the dock's root on this side.
   *  Without `stackId` and `edge`, the entry is the whole dock. */
  edge?: SplitSide
  getRect(): DOMRect | null
  /** Lets the overlay clamp the indicator to the stack's canvas. */
  getElement?(): HTMLElement | null
  /** Tabs the drawn stack shows; a lone tab cannot split its own stack. */
  tabCount?(): number
  /** False rejects the dragged panel. */
  acceptsPanel?(panelType: string): boolean
}

/** A canvas the canvas view draws, as the drag system sees it. */
export interface CanvasDropSurface {
  workspaceId: string
  canvasId: string
  /** The canvas container: the element hit testing finds and the origin of
   *  view coordinates. */
  getElement(): HTMLElement | null
  /** view = canvas * zoom + offset (workspace/canvas `canvasToView`). */
  getViewport(): { offset: Point; zoom: number }
}

const dropZones = new Map<string, DropZoneEntry>()
const canvasSurfaces = new Set<CanvasDropSurface>()

export function registerDropZone(entry: DropZoneEntry): () => void {
  dropZones.set(entry.id, entry)
  return () => { if (dropZones.get(entry.id) === entry) dropZones.delete(entry.id) }
}

export function getDropZoneEntries(): readonly DropZoneEntry[] {
  return [...dropZones.values()]
}

export function registerCanvasDropSurface(surface: CanvasDropSurface): () => void {
  canvasSurfaces.add(surface)
  return () => { canvasSurfaces.delete(surface) }
}

export function canvasSurfaceFor(workspaceId: string, canvasId: string): CanvasDropSurface | null {
  for (const surface of canvasSurfaces) {
    if (surface.workspaceId === workspaceId && surface.canvasId === canvasId) return surface
  }
  return null
}

/** The canvas whose container holds `element`. */
export function canvasSurfaceAt(element: Element | null): CanvasDropSurface | null {
  for (let el: Element | null = element; el; el = el.parentElement) {
    for (const surface of canvasSurfaces) if (surface.getElement() === el) return surface
  }
  return null
}

const TAB_BAR_DROP_HINT = 38

/** Which part of a stack the cursor is over: its tab bar (`center`), an edge
 *  band, or its body (null). */
export function resolveDropEdge(
  cursorX: number,
  cursorY: number,
  rect: DOMRect,
): 'top' | 'bottom' | 'left' | 'right' | 'center' | null {
  const relX = cursorX - rect.left
  const relY = cursorY - rect.top
  const w = rect.width
  const h = rect.height

  if (relY >= 0 && relY < TAB_BAR_DROP_HINT) return 'center'

  const edgeFraction = 0.12
  const EDGE_MAX_PX = 60
  const leftEdge = Math.min(w * edgeFraction, EDGE_MAX_PX)
  const rightEdgeStart = w - leftEdge
  const topEdge = Math.min(h * edgeFraction, EDGE_MAX_PX)
  const bottomEdgeStart = h - topEdge

  if (relY < topEdge && relY < relX && relY < (w - relX)) return 'top'
  if (relY > bottomEdgeStart && (h - relY) < relX && (h - relY) < (w - relX)) return 'bottom'
  if (relX < leftEdge) return 'left'
  if (relX > rightEdgeStart) return 'right'
  return null
}

/** Tests only. */
export function resetDragRegistry(): void {
  dropZones.clear()
  canvasSurfaces.clear()
}
