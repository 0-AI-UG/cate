// Drop targets the views register: dock stacks and window edges, and canvas
// surfaces. Hit testing reads them on every move.

import type { Point } from '@workspace/canvas/contract'
import type { DockRef, HostRef, LayoutId, SplitSide, StackId } from '@workspace/document/contract'
import type { DragSource, DropTarget } from './types'

export interface DropZoneEntry {
  id: string
  workspaceId: string
  dock: DockRef
  /** The window or canvas node holding `dock`. */
  host: HostRef
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
  /** False when the stack draws no tab bar (a one-panel window pane): its
   *  whole body splits by the nearest edge. */
  hasTabBar?(): boolean
  /** A window's tab strip (`dock` is unused). It keeps the state of a drag
   *  over it (which gap is open), so it picks the drop itself. */
  strip?: { resolve(cursorX: number, source: DragSource): StripTarget | null }
  /** The sidebar's workspace tree (`dock` is unused). Like a strip, it picks
   *  the drop itself from the cursor's y. */
  tree?: { resolve(cursorY: number, source: DragSource): TreeTarget | null }
}

/** A drop in a tab strip, before the workspace and host are added. */
export type StripTarget =
  | { kind: 'tab-slot'; index: number }
  | { kind: 'group-slot'; layoutId: LayoutId; beside: StackId; side: 'left' | 'right'; slot: number }
  | { kind: 'group-home'; layoutId: LayoutId; slot: number }

/** A drop in the sidebar tree, before the workspace is added. */
export type TreeTarget = DistributiveOmit<
  Extract<DropTarget, { kind: 'tab-slot' | 'group-slot' | 'group-home' | 'stack-slot' | 'canvas-slot' }>,
  'workspaceId'
>
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

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
  tabBar = true,
): 'top' | 'bottom' | 'left' | 'right' | 'center' | null {
  const relX = cursorX - rect.left
  const relY = cursorY - rect.top
  const w = rect.width
  const h = rect.height

  // No tab bar: every point of the pane splits it, by the nearest edge.
  if (!tabBar) {
    const dx = relX / w - 0.5
    const dy = relY / h - 0.5
    return Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'top' : 'bottom')
  }
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
