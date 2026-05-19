// =============================================================================
// useDockDrag — global drag state for dock-aware panel dragging.
// Tracks what's being dragged, cursor position, and the active drop target.
// Uses a Zustand store so multiple components can read drag state reactively.
// =============================================================================

import { create } from 'zustand'
import type { StoreApi } from 'zustand'
import type { DockZonePosition, DockDropTarget, Point, PanelType } from '../../shared/types'
import type { DockStore } from '../stores/dockStore'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type DragSource =
  | { type: 'canvas'; nodeId: string }
  | { type: 'dock'; zone: DockZonePosition; stackId: string }

export interface DockDragState {
  /** Whether a dock-aware drag is currently active */
  isDragging: boolean
  /** The panel being dragged */
  draggedPanelId: string | null
  /** The panel type (for visual feedback) */
  draggedPanelType: PanelType | null
  /** The panel title (for visual feedback) */
  draggedPanelTitle: string | null
  /** Where the drag originated */
  dragSource: DragSource | null
  /** Owning DockStore of the source. When the source is a canvas node body
   *  drag this is null (the source is a CanvasStore, not a DockStore). Set
   *  for tab drags out of mini-docks and main dock zones. */
  sourceDockStoreApi: StoreApi<DockStore> | null
  /** Current cursor position in window coordinates */
  cursorPosition: Point | null
  /** The currently resolved drop target (null if cursor isn't over a valid target) */
  activeDropTarget: DockDropTarget | null
  /** Set true when CanvasDropZone consumes a drop, so source-side mouseup
   *  handlers know to skip their own executeDrop path. Reset on every
   *  startDrag and endDrag. */
  canvasDropConsumed: boolean
  /** Offset from the cursor to the top-left of the source panel's on-screen
   *  rect at drag start, in screen pixels. Used by CanvasDropZone to render
   *  the ghost 1:1 over where the user grabbed the window, instead of
   *  centering it on the cursor. Null when unknown. */
  dragGrabOffset: Point | null
  /** Source panel's on-screen size at drag start, in screen pixels. Used by
   *  CanvasDropZone to render the ghost 1:1 with the real window. Null when
   *  unknown (e.g. canvas-source drags provide size via canvas node). */
  dragSourceSize: { width: number; height: number } | null
  /** Canvas-space size of the source node when the drag originated inside a
   *  canvas-node mini-dock (or from a canvas node body). Lets CanvasDropZone
   *  preview AND place the dropped node at the existing node's actual size
   *  instead of falling back to PANEL_DEFAULT_SIZES. Null otherwise. */
  dragSourceNodeSize: { width: number; height: number } | null
}

interface DockDragActions {
  /** Start a dock-aware drag */
  startDrag: (
    panelId: string,
    panelType: PanelType,
    panelTitle: string,
    source: DragSource,
    sourceDockStoreApi?: StoreApi<DockStore> | null,
    grabOffset?: Point | null,
    sourceSize?: { width: number; height: number } | null,
    sourceNodeSize?: { width: number; height: number } | null,
  ) => void
  /** Update cursor position during drag */
  updateCursor: (position: Point) => void
  /** Set the currently hovered drop target */
  setDropTarget: (target: DockDropTarget | null) => void
  /** Mark the active drag as consumed by the CanvasDropZone overlay so the
   *  source's own mouseup handler skips its drop logic. */
  markCanvasDropConsumed: () => void
  /** End the drag (drop or cancel) */
  endDrag: () => void
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useDockDragStore = create<DockDragState & DockDragActions>((set) => ({
  isDragging: false,
  draggedPanelId: null,
  draggedPanelType: null,
  draggedPanelTitle: null,
  dragSource: null,
  sourceDockStoreApi: null,
  cursorPosition: null,
  activeDropTarget: null,
  canvasDropConsumed: false,
  dragGrabOffset: null,
  dragSourceSize: null,
  dragSourceNodeSize: null,

  startDrag(panelId, panelType, panelTitle, source, sourceDockStoreApi = null, grabOffset = null, sourceSize = null, sourceNodeSize = null) {
    set({
      isDragging: true,
      draggedPanelId: panelId,
      draggedPanelType: panelType,
      draggedPanelTitle: panelTitle,
      dragSource: source,
      sourceDockStoreApi,
      cursorPosition: null,
      activeDropTarget: null,
      canvasDropConsumed: false,
      dragGrabOffset: grabOffset,
      dragSourceSize: sourceSize,
      dragSourceNodeSize: sourceNodeSize,
    })
  },

  updateCursor(position) {
    set({ cursorPosition: position })
  },

  setDropTarget(target) {
    set({ activeDropTarget: target })
  },

  markCanvasDropConsumed() {
    set({ canvasDropConsumed: true })
  },

  endDrag() {
    set({
      isDragging: false,
      draggedPanelId: null,
      draggedPanelType: null,
      draggedPanelTitle: null,
      dragSource: null,
      sourceDockStoreApi: null,
      cursorPosition: null,
      activeDropTarget: null,
      canvasDropConsumed: false,
      dragGrabOffset: null,
      dragSourceSize: null,
      dragSourceNodeSize: null,
    })
  },
}))

// -----------------------------------------------------------------------------
// Drop zone registry — components register their bounding rects
// -----------------------------------------------------------------------------

export interface DropZoneEntry {
  id: string
  zone: DockZonePosition
  stackId?: string
  getRect: () => DOMRect | null
  /** Owning DockStore for this drop zone. When omitted, drops use the global
   *  singleton. Per-canvas-node DockStores supply their own here so cross-store
   *  drag-and-drop can route the drop to the correct store. */
  dockStoreApi?: StoreApi<DockStore>
  /** Optional predicate — return false to reject the dragged panel type for
   *  this drop zone. Used to keep canvas panels out of canvas-node mini-docks. */
  acceptsPanelType?: (type: PanelType) => boolean
}

const dropZoneRegistry: DropZoneEntry[] = []

export function registerDropZone(entry: DropZoneEntry): () => void {
  dropZoneRegistry.push(entry)
  return () => {
    const idx = dropZoneRegistry.indexOf(entry)
    if (idx >= 0) dropZoneRegistry.splice(idx, 1)
  }
}

export function getDropZoneEntries(): readonly DropZoneEntry[] {
  return dropZoneRegistry
}

// -----------------------------------------------------------------------------
// Hit testing — resolve cursor position to a drop target
// -----------------------------------------------------------------------------

/** Approximate height of a DockTabStack tab bar (covers both the standard
 *  35px and the compact 24px variants). When the cursor is within this many
 *  pixels of the stack's top, the drop is forced to "tab" — the user is
 *  pointing at the tab bar, not at the top edge of the panel content. */
const TAB_BAR_DROP_HINT = 38

/** Resolve which of the 5 drop zones (top/bottom/left/right/center) the cursor
 *  is in relative to a container rect. Returns the edge, 'center' (only when
 *  the cursor is over the tab strip), or null when the cursor is in the
 *  body's safe zone — letting the drag pass through without activating any
 *  drop target. This avoids the prior eager behavior where the entire panel
 *  body lit up with a full-screen blue tab indicator the moment the cursor
 *  passed over it. */
export function resolveDropEdge(
  cursorX: number,
  cursorY: number,
  rect: DOMRect,
): 'top' | 'bottom' | 'left' | 'right' | 'center' | null {
  const relX = cursorX - rect.left
  const relY = cursorY - rect.top
  const w = rect.width
  const h = rect.height

  // Tab-bar zone: cursor over the tab strip → tab drop ("add as new tab").
  // Anywhere else in the body returns null unless the cursor is genuinely
  // on an edge, so docking only triggers when the user means it.
  if (relY >= 0 && relY < TAB_BAR_DROP_HINT) return 'center'

  // Edge zones: a narrow ~12% strip (capped at 60px) along each edge.
  // Previously 25%, which meant a quarter of every panel was a split zone
  // and you couldn't drag a tab across the canvas without triggering one.
  const edgeFraction = 0.12
  const EDGE_MAX_PX = 60
  const leftEdge = Math.min(w * edgeFraction, EDGE_MAX_PX)
  const rightEdgeStart = w - leftEdge
  const topEdge = Math.min(h * edgeFraction, EDGE_MAX_PX)
  const bottomEdgeStart = h - topEdge

  // Check edges in priority order — diagonal regions resolve to the nearer
  // edge so a corner doesn't flicker between two split targets.
  if (relY < topEdge && relY < relX && relY < (w - relX)) return 'top'
  if (relY > bottomEdgeStart && (h - relY) < relX && (h - relY) < (w - relX)) return 'bottom'
  if (relX < leftEdge) return 'left'
  if (relX > rightEdgeStart) return 'right'
  // Body — no drop target, let the drag pass through.
  return null
}

/** Full hit test that also returns the matched entry's owning DockStore (if any).
 *  Used by per-store drag handlers (e.g. canvas-node tab drag) so they can drop
 *  into a different DockStore than the source. */
export function hitTestDropTargetWithStore(
  cursorX: number,
  cursorY: number,
): { target: DockDropTarget; dockStoreApi?: StoreApi<DockStore> } | null {
  const result = hitTestInternal(cursorX, cursorY)
  if (!result) return null
  return { target: result.target, dockStoreApi: result.entry.dockStoreApi }
}

/** Full hit test: given cursor in window coordinates, find the best drop target.
 *  Collects all matching entries and picks the most specific one:
 *  stack (with stackId) > zone (without stackId).
 *  Among same-priority entries, the smallest area wins. */
export function hitTestDropTarget(
  cursorX: number,
  cursorY: number,
): DockDropTarget | null {
  return hitTestInternal(cursorX, cursorY)?.target ?? null
}

function hitTestInternal(
  cursorX: number,
  cursorY: number,
): { target: DockDropTarget; entry: DropZoneEntry } | null {
  // The currently dragged panel type — used to skip drop zones that reject
  // it (e.g. canvas-node mini-docks reject 'canvas' to prevent nesting).
  const draggedType = useDockDragStore.getState().draggedPanelType

  // Collect all entries whose rect contains the cursor
  const hits: { entry: DropZoneEntry; rect: DOMRect; area: number }[] = []

  for (const entry of dropZoneRegistry) {
    if (entry.acceptsPanelType && draggedType && !entry.acceptsPanelType(draggedType)) continue
    const rect = entry.getRect()
    if (!rect) continue
    if (
      cursorX >= rect.left &&
      cursorX <= rect.right &&
      cursorY >= rect.top &&
      cursorY <= rect.bottom
    ) {
      hits.push({ entry, rect, area: rect.width * rect.height })
    }
  }

  if (hits.length === 0) return null

  // Sort by specificity: stackId entries first, then zone-level
  // Within same specificity, prefer smallest area (tightest fit)
  hits.sort((a, b) => {
    const specA = a.entry.stackId ? 0 : 1
    const specB = b.entry.stackId ? 0 : 1
    if (specA !== specB) return specA - specB
    return a.area - b.area
  })

  const best = hits[0]

  if (best.entry.stackId) {
    const edge = resolveDropEdge(cursorX, cursorY, best.rect)
    if (edge === null) {
      // Body safe zone — no drop. Let the drag pass through (e.g. to the
      // canvas) instead of hijacking it with a full-panel tab indicator.
      return null
    }
    if (edge === 'center') {
      return { target: { type: 'tab', stackId: best.entry.stackId }, entry: best.entry }
    }
    return {
      target: { type: 'split', stackId: best.entry.stackId, edge },
      entry: best.entry,
    }
  }
  // Zone-level drop (no specific stack)
  return { target: { type: 'zone', zone: best.entry.zone }, entry: best.entry }
}

// -----------------------------------------------------------------------------
// Cross-window drag support — hook to listen for drags from other windows
// -----------------------------------------------------------------------------

import type { PanelTransferSnapshot } from '../../shared/types'

/** Active cross-window drag state */
let crossWindowSnapshot: PanelTransferSnapshot | null = null

export function getCrossWindowSnapshot(): PanelTransferSnapshot | null {
  return crossWindowSnapshot
}

/**
 * Set up listeners for cross-window drag events from the main process.
 * Call this once per window. Returns a cleanup function.
 */
export function setupCrossWindowDragListeners(
  onDrop?: (snapshot: PanelTransferSnapshot, target: DockDropTarget) => void,
): () => void {
  const cleanups: (() => void)[] = []

  // Listen for cursor updates from other windows
  cleanups.push(
    window.electronAPI.onCrossWindowDragUpdate((screenPos: Point, snapshot: PanelTransferSnapshot) => {
      crossWindowSnapshot = snapshot

      // Convert screen coords to local window coords
      // (screenPos is in screen space, we need window-local)
      const localX = screenPos.x - window.screenX
      const localY = screenPos.y - window.screenY

      // Check if cursor is inside this window
      if (localX >= 0 && localY >= 0 && localX < window.innerWidth && localY < window.innerHeight) {
        // Start drag display if not already dragging
        const dragState = useDockDragStore.getState()
        if (!dragState.isDragging) {
          useDockDragStore.getState().startDrag(
            snapshot.panel.id,
            snapshot.panel.type,
            snapshot.panel.title,
            { type: 'dock', zone: 'center', stackId: '' },
          )
        }
        // Update cursor and hit test
        useDockDragStore.getState().updateCursor({ x: localX, y: localY })
        const target = hitTestDropTarget(localX, localY)
        useDockDragStore.getState().setDropTarget(target)
      } else {
        // Cursor left this window — end local drag display
        const dragState = useDockDragStore.getState()
        if (dragState.isDragging && dragState.draggedPanelId === snapshot.panel.id) {
          useDockDragStore.getState().endDrag()
        }
      }
    }),
  )

  // Listen for drag end
  cleanups.push(
    window.electronAPI.onDragEnd(() => {
      // If we had an active cross-window drag with a resolved target, execute the drop
      const dragState = useDockDragStore.getState()
      if (dragState.isDragging && crossWindowSnapshot && dragState.activeDropTarget) {
        onDrop?.(crossWindowSnapshot, dragState.activeDropTarget)
        window.electronAPI.crossWindowDragDrop(crossWindowSnapshot.panel.id)
      }
      useDockDragStore.getState().endDrag()
      crossWindowSnapshot = null
    }),
  )

  return () => {
    cleanups.forEach((fn) => fn())
    crossWindowSnapshot = null
  }
}
