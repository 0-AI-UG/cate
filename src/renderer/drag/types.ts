// =============================================================================
// drag/types — shared shapes for the drag system. Pure: no React, no IPC, no
// zustand. The runtime reducer consumes DragEvent and emits DragEffect; the
// store mirrors DragState; the dispatcher (useDragOp) wires DOM/IPC.
// =============================================================================

import type { StoreApi } from 'zustand'
import type {
  Point,
  Size,
  PanelType,
  PanelState,
  DockZonePosition,
  PanelTransferSnapshot,
} from '../../shared/types'
import type { CanvasStore } from '../stores/canvasStore'
import type { DockStore } from '../stores/dockStore'

// -----------------------------------------------------------------------------
// Source / target unions
// -----------------------------------------------------------------------------

/** Runtime-shared shape for an in-flight drag. Collapsed to a single record:
 *  `panelId` is always available, and the kind-specific data lives in
 *  `origin`. The dispatcher input (DragOpSourceSpec, below) keeps its richer
 *  variants — only the runtime shape is unified, so commit-time semantics are
 *  the only branch on `origin.kind`. */
export type DragSource = {
  panelId: string
  origin:
    | {
        kind: 'canvas-node'
        canvasStoreApi: StoreApi<CanvasStore>
        nodeId: string
      }
    | {
        kind: 'dock-tab'
        dockStoreApi: StoreApi<DockStore>
        stackId: string
        zone: DockZonePosition
        /** Set when the source dock is a per-canvas-node mini-dock — used so a
         *  tab dragged out of a node back onto its own canvas resolves as a
         *  reposition of the existing node instead of an add. */
        sourceNodeId?: string
        /** Set when the source dock is a per-canvas-node mini-dock — lets the
         *  geometry measurement use the owning canvas's zoom + node size
         *  directly, matching the canvas-node body drag path 1:1. */
        sourceCanvasStoreApi?: StoreApi<CanvasStore>
      }
    | {
        /** The source is a single-panel detached window (PanelWindowShell).
         *  On a successful cross-window claim the source cleans up by closing
         *  its own window. */
        kind: 'panel-window'
      }
    | {
        /** The source lives in **another** renderer window. This window's
         *  runtime is mirroring the drag for ghost rendering + local hit
         *  testing. On commit the dispatcher claims the drop via IPC; the
         *  source window's runtime handles its own cleanup on DRAG_END. */
        kind: 'remote'
        snapshot: PanelTransferSnapshot
      }
}

export type DropTarget =
  | {
      kind: 'canvas-reposition'
      canvasStoreApi: StoreApi<CanvasStore>
      nodeId: string
      origin: Point
    }
  | {
      kind: 'canvas-add'
      canvasStoreApi: StoreApi<CanvasStore>
      origin: Point
      size: Size
    }
  | {
      kind: 'dock-split'
      dockStoreApi: StoreApi<DockStore>
      stackId: string
      edge: 'top' | 'bottom' | 'left' | 'right'
    }
  | { kind: 'dock-tab'; dockStoreApi: StoreApi<DockStore>; stackId: string }
  | { kind: 'dock-zone'; dockStoreApi: StoreApi<DockStore>; zone: DockZonePosition }
  | { kind: 'detach'; screen: Point }

// -----------------------------------------------------------------------------
// State snapshot — what the store/UI sees.
// -----------------------------------------------------------------------------

export interface DragState {
  isDragging: boolean
  source: DragSource | null
  panel: { id: string; type: PanelType; title: string } | null
  /** Canvas-space offset from source-node top-left to grab point. */
  grab: Point | null
  /** Canvas-space size the dropped node will have. */
  ghostSize: Size | null
  /** Zoom level at which the ghost should be rendered (= the source canvas's
   *  zoom at drag-start time, or 1 for sources not on a canvas). Frozen at
   *  START so the ghost size/grab don't shift as the cursor crosses zones. */
  ghostZoom: number
  cursor: { client: Point; screen: Point; insideWindow: boolean } | null
  target: DropTarget | null
  /** Set when the cursor has left this window and the main process is showing
   *  the native ghost. Cleared when the cursor returns or the drag ends. */
  crossWindowSnapshot: PanelTransferSnapshot | null
}

export const INITIAL_DRAG_STATE: DragState = {
  isDragging: false,
  source: null,
  panel: null,
  grab: null,
  ghostSize: null,
  ghostZoom: 1,
  cursor: null,
  target: null,
  crossWindowSnapshot: null,
}

// -----------------------------------------------------------------------------
// Dispatcher input spec — useDragOp's public surface.
// -----------------------------------------------------------------------------

export type DragOpSourceSpec =
  | {
      kind: 'canvas-node'
      canvasStoreApi: StoreApi<CanvasStore>
      nodeId: string
      panelId: string
      panelType: PanelType
      panelTitle: string
      /** Authoritative PanelState for snapshot building. Required because dock
       *  windows don't sync useAppStore.workspaces — the caller (which owns the
       *  panel) must supply it so cross-window-drag-start can serialize. */
      panel: PanelState
    }
  | {
      kind: 'dock-tab'
      dockStoreApi: StoreApi<DockStore>
      zone: DockZonePosition
      stackId: string
      panelId: string
      panelType: PanelType
      panelTitle: string
      sourceNodeId?: string
      /** Set when the source dock is a per-canvas-node mini-dock — lets the
       *  geometry measurement use the owning canvas's zoom + node size
       *  directly, matching the canvas-node body drag path 1:1. */
      sourceCanvasStoreApi?: StoreApi<CanvasStore>
      /** Authoritative PanelState for snapshot building. See note on
       *  canvas-node variant. */
      panel: PanelState
    }
  | {
      kind: 'panel-window'
      panelId: string
      panelType: PanelType
      panelTitle: string
      panel: PanelState
    }

// -----------------------------------------------------------------------------
// Runtime event/effect protocol
// -----------------------------------------------------------------------------

export type DragEvent =
  | {
      type: 'START'
      source: DragSource
      panel: { id: string; type: PanelType; title: string }
      grab: Point
      ghostSize: Size
      ghostZoom: number
      cursor: Point
    }
  | {
      type: 'MOVE'
      client: Point
      screen: Point
      insideWindow: boolean
      /** Optional snapshot built by the caller for cross-window hand-off. If
       *  provided AND the cursor just transitioned outside, the runtime emits
       *  a 'cross-window-start' effect. */
      snapshot?: PanelTransferSnapshot | null
    }
  | { type: 'TARGET'; target: DropTarget | null }
  | { type: 'CROSS_WINDOW_OPEN'; snapshot: PanelTransferSnapshot }
  | { type: 'CROSS_WINDOW_CLOSE' }
  | { type: 'END' }
  | { type: 'CANCEL' }

export type DragEffect =
  | { kind: 'set-body-class'; cls: string; on: boolean }
  | {
      kind: 'cross-window-start'
      snapshot: PanelTransferSnapshot
      screen: Point
    }
  | { kind: 'cross-window-cancel' }
  | { kind: 'push-history' }
  | {
      kind: 'commit'
      source: DragSource
      target: DropTarget
      panel: { id: string; type: PanelType; title: string }
    }
  | { kind: 'clear-state' }

export interface RuntimeState {
  /** Mirrors what the store will publish. */
  state: DragState
  /** True once the dispatcher has armed the drag and committed start effects. */
  armed: boolean
  /** True when a native cross-window ghost is currently being shown by main. */
  crossWindowActive: boolean
  /** Effects to run since the last reduce() call. The dispatcher drains and
   *  clears these after each step. */
  effects: DragEffect[]
}

export const INITIAL_RUNTIME_STATE: RuntimeState = {
  state: INITIAL_DRAG_STATE,
  armed: false,
  crossWindowActive: false,
  effects: [],
}
