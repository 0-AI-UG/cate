// =============================================================================
// Canvas store — shared types.
// Split out of canvasStore.ts so each slice can import the store shape without a
// runtime dependency on the store module itself (avoids an import cycle).
// =============================================================================

import type { StoreApi } from 'zustand'
import type {
  CanvasNodeId,
  CanvasNodeState,
  DockLayoutNode,
  Point,
  Rect,
  Size,
  PanelType,
} from '../../../shared/types'
import type { PlacementCandidate } from '../../canvas/placement'

/** Interactive ghost placement awaiting a user-chosen spot. */
export interface PendingPlacement {
  panelId: string
  panelType: PanelType
  /** 3–5 recommended spots; candidates[0] is the best. User picks by click or number. */
  candidates: PlacementCandidate[]
  hoveredIndex: number | null
  /** Free "place anywhere" mode — armed by pressing F. While armed, the cursor
   *  shows a "Place here" ghost and a click drops there; otherwise the ghost is
   *  hidden and clicking empty canvas cancels. */
  freeArmed: boolean
  /** Escape hatch preview: where a free "click-anywhere" placement would land
   *  (only while `freeArmed`). */
  freeGhost: { point: Point; size: Size } | null
  /** Viewport before we zoomed out to show recommendations — restored on cancel/commit. */
  prevZoom: number
  prevOffset: Point
  /** Invoked if the placement is cancelled — rolls the orphan panel record back. */
  onCancelled?: (panelId: string) => void
}

export interface CanvasStoreState {
  nodes: Record<CanvasNodeId, CanvasNodeState>
  viewportOffset: Point
  zoomLevel: number
  focusedNodeId: CanvasNodeId | null
  /** Increments on every focus action — lets panels re-run focus side effects even when focusedNodeId doesn't change. */
  focusEpoch: number
  /** Per-node active worktree id, published by CanvasNode from its active tab.
   *  Read by the worktree sludge/lens layers (which live outside the per-node
   *  dock store and so can't see the active tab directly). `null` = untagged.
   *  Stale entries for removed nodes are harmless — consumers iterate `nodes`. */
  nodeActiveWorktreeId: Record<string, string | null>
  nextZOrder: number
  nextCreationIndex: number
  containerSize: Size
  snapGuides: {
    lines: Array<{
      axis: 'x' | 'y'
      position: number
      type: 'edge' | 'center'
    }>
  }
  selectedNodeIds: Set<string>
  /** When true, the auto-focus-largest-visible hook stands down. Set while the
   *  user is moving the canvas by keyboard (Cmd+Arrow jump / Shift+Arrow pan)
   *  so those movements don't auto-activate whatever scrolls into view; cleared
   *  by any explicit focus, manual pan, or zoom. */
  suppressAutoFocus: boolean
  /** Undo history — snapshots of {nodes}. */
  history: CanvasHistoryEntry[]
  /** Redo stack — populated when undo() is called. */
  future: CanvasHistoryEntry[]
  /** Interactive ghost placement in progress (null when idle). */
  pendingPlacement: PendingPlacement | null
}

export interface CanvasHistoryEntry {
  nodes: Record<CanvasNodeId, CanvasNodeState>
  focusedNodeId: CanvasNodeId | null
  selectedNodeIds: Set<string>
}

export interface CanvasStoreActions {
  // Zoom animation control
  cancelZoomAnimation: () => void

  // Mutations
  addNode: (
    panelId: string,
    panelType: PanelType,
    position?: Point,
    size?: Size,
  ) => CanvasNodeId
  removeNode: (id: CanvasNodeId) => void
  finalizeRemoveNode: (nodeId: CanvasNodeId) => void
  setNodeAnimationState: (nodeId: CanvasNodeId, state: 'entering' | 'exiting' | 'idle') => void
  moveNode: (id: CanvasNodeId, origin: Point) => void
  resizeNode: (id: CanvasNodeId, size: Size, origin?: Point) => void
  focusNode: (id: CanvasNodeId) => void
  unfocus: () => void
  toggleMaximize: (id: CanvasNodeId, viewportSize: Size) => void
  setZoom: (level: number) => void
  setViewportOffset: (offset: Point) => void
  setZoomAndOffset: (zoom: number, offset: Point) => void
  setContainerSize: (size: Size) => void
  zoomAroundCenter: (newZoom: number) => void
  animateZoomTo: (targetZoom: number) => void
  // Smoothly ease the viewport offset toward a target (Shift/Cmd+Arrow movement)
  animateViewportTo: (target: Point) => void

  // Derived getters
  canvasToView: (point: Point) => Point
  viewToCanvas: (point: Point) => Point
  viewFrame: (nodeId: CanvasNodeId) => Rect | null
  nodeForPanel: (panelId: string) => CanvasNodeId | null
  sortedNodesByCreationOrder: () => CanvasNodeState[]
  nextNode: () => CanvasNodeId | null
  previousNode: () => CanvasNodeId | null

  // Focus and center viewport on a node
  focusAndCenter: (nodeId: CanvasNodeId) => void

  // Interactive ghost placement
  /** Record the latest canvas-space pointer position so recommendations can be
   *  anchored to where the mouse is hovering. Non-reactive (no re-render). */
  setPlacementPointer: (point: Point | null) => void
  /** Begin interactive ghost placement: compute 3–5 recommended spots, zoom out
   *  to reveal them, and render numbered ghosts. Returns true if ghosts are shown
   *  (caller must NOT also place the node). `onCancelled` rolls the panel back. */
  beginPlacement: (
    panelId: string,
    panelType: PanelType,
    onCancelled?: (panelId: string) => void,
  ) => boolean
  /** Commit the pending placement at the given candidate index; returns the new node id. */
  commitPlacement: (index: number) => CanvasNodeId | null
  /** Arm/disarm free "place anywhere" mode (press F). Disarming clears the ghost. */
  setFreeArmed: (armed: boolean) => void
  /** Escape hatch: preview a free placement centred on `point` (canvas-space),
   *  nudged to the nearest non-overlapping spot. No-op when idle. */
  updatePlacementCursor: (point: Point) => void
  /** Escape hatch: commit a free placement centred on `point` (click-anywhere). */
  commitFreePlacement: (point: Point) => CanvasNodeId | null
  /** Cancel the pending placement and roll back the orphan panel record. */
  cancelPlacement: () => void
  /** Highlight a candidate ghost (null clears the hover). */
  setPlacementHover: (index: number | null) => void

  // Move focus to the spatially-nearest node in a direction, centering it
  navigateDirection: (dir: 'up' | 'down' | 'left' | 'right') => void

  // Move the selection cursor to the spatially-nearest node in a direction and
  // centre it — without focusing it, so panel content never grabs the keyboard
  // and the user can keep jumping (Cmd+Arrow).
  navigateSelect: (dir: 'up' | 'down' | 'left' | 'right') => void

  // Pan the canvas viewport one step in a direction (Shift+Arrow).
  panViewport: (dir: 'up' | 'down' | 'left' | 'right') => void

  zoomToFit: () => void
  zoomToSelection: () => void

  /** Publish (or clear) the active-tab worktree for a node. */
  setNodeActiveWorktree: (nodeId: string, worktreeId: string | null) => void

  // Z-order management
  moveToFront: (nodeId: CanvasNodeId) => void
  moveToBack: (nodeId: CanvasNodeId) => void

  togglePin: (id: CanvasNodeId) => void

  setSnapGuides: (guides: {
    lines: Array<{
      axis: 'x' | 'y'
      position: number
      type: 'edge' | 'center'
    }>
  }) => void
  clearSnapGuides: () => void

  autoLayout: () => void

  // Selection
  selectNodes: (ids: string[], additive?: boolean) => void
  clearSelection: () => void
  selectAll: () => void
  toggleNodeSelection: (id: string) => void
  deleteSelection: () => void

  // Bulk arrangement of the current selection
  stackSelected: (axis: 'row' | 'column', gap?: number) => void
  tidyGridSelected: (gap?: number) => void

  // Per-node dock layout — replaces split/stack actions. Each canvas node owns
  // a tree (rendered via the dock primitives) that lives here as serialised
  // state. The per-node DockStore in CanvasNodeWrapper writes back via this.
  setNodeDockLayout: (nodeId: CanvasNodeId, layout: DockLayoutNode | null) => void

  // Undo/redo history
  pushHistory: () => void
  undo: () => void
  redo: () => void
  clearHistory: () => void

  // Bulk reset (used when switching workspaces)
  loadWorkspaceCanvas: (
    nodes: Record<CanvasNodeId, CanvasNodeState>,
    viewportOffset: Point,
    zoomLevel: number,
  ) => void
}

export type CanvasStore = CanvasStoreState & CanvasStoreActions

// Zustand setter/getter shapes shared by every slice creator. Each slice is a
// `(set, get, ctx) => Pick<CanvasStoreActions, ...>` function; the store factory
// spreads them all into one object so they keep sharing one set/get.
export type CanvasSet = StoreApi<CanvasStore>['setState']
export type CanvasGet = StoreApi<CanvasStore>['getState']
