// Shapes of the drag system. The runtime reducer turns DragEvents into a new
// DragState plus DragEffects; the dispatcher (useDragOp) runs the effects.
// A drag names panels, stacks, nodes and canvases by id in one workspace; the
// document is the only placement state, so a drop is one document op.

import type { Point, Size } from '@workspace/canvas/contract'
import type { DockRef, HostRef, LayoutId, PanelId, SplitSide, StackId } from '@workspace/document/contract'
import type { CrossWindowDrag } from './ports'

export interface DragPanel {
  id: PanelId
  type: string
  title: string
}

/** The thing in flight. `origin` says where it came from. */
export interface DragSource {
  workspaceId: string
  panelId: PanelId
  /** Started on a row of the sidebar's workspace tree: never detaches into a
   *  new window. */
  from?: 'sidebar'
  origin:
    | {
        kind: 'canvas-node'
        canvasId: string
        nodeId: string
        /** Group move: the grabbed node's origin at the start, and the other
         *  selected nodes with theirs. Only for a real multi-selection. */
        startOrigin?: Point
        members?: { nodeId: string; startOrigin: Point }[]
      }
    | {
        kind: 'dock-tab'
        /** The dock the tab sits in, and the window or canvas node holding it. */
        dock: DockRef
        host: HostRef
        stackId: StackId
      }
    | {
        /** A whole layout dragged by its anchor chip in a tab strip. `panelId`
         *  of the source is one of its panels, which stands for it in the ghost. */
        kind: 'layout'
        host: HostRef
        layoutId: LayoutId
        /** Set when the drag started in another window: this one mirrors it. */
        remote?: CrossWindowDrag
      }
    | {
        /** A drag that started in another window of this client; this window
         *  mirrors it for hit testing and the ghost. */
        kind: 'remote'
        drag: CrossWindowDrag
      }
}

/** Screen-px rect of the ghost on a snapped canvas drop. */
export interface GhostRect {
  left: number
  top: number
  width: number
  height: number
}

/** The client-state key (on a canvas panel) of the order its panels are listed
 *  in. A canvas does not care in which order its nodes are listed, so a drag
 *  only rearranges the list. */
export const CANVAS_ORDER_KEY = 'sidebar.order'

export type DropTarget =
  | {
      kind: 'canvas-reposition'
      workspaceId: string
      canvasId: string
      nodeId: string
      origin: Point
      zoom: number
      ghostRect?: GhostRect
    }
  | {
      kind: 'canvas-add'
      workspaceId: string
      canvasId: string
      origin: Point
      size: Size
      zoom: number
      ghostRect?: GhostRect
      /** Set when the canvas takes no such drop: the ghost shows this, and the release does nothing. */
      refused?: string
    }
  | { kind: 'dock-split'; workspaceId: string; dock: DockRef; stackId: StackId; edge: SplitSide }
  | { kind: 'dock-tab'; workspaceId: string; dock: DockRef; stackId: StackId }
  /** A whole dock: its root split on `edge` (a window's edge strip), or its
   *  first stack (a new stack in an empty window). */
  | { kind: 'dock-zone'; workspaceId: string; dock: DockRef; edge?: SplitSide }
  /** A gap of a window's tab strip: the dropped panel becomes a plain tab
   *  (a dragged layout moves) at `index` among the host's layouts. */
  | { kind: 'tab-slot'; workspaceId: string; host: HostRef; index: number; via?: 'tree' }
  /** The dragged pane's own spot in its group, at `slot`: nothing drops. */
  | { kind: 'group-home'; workspaceId: string; layoutId: LayoutId; slot: number; via?: 'tree' }
  /** Inside a group of the strip: the dropped panel becomes a new pane beside
   *  the stack of the chip next to the gap (`slot` is the gap's index among
   *  the group's chips, for the ghost chip). */
  | { kind: 'group-slot'; workspaceId: string; layoutId: LayoutId; beside: StackId; side: 'left' | 'right'; slot: number; via?: 'tree' }
  /** A tab position in a stack: after `after`, first when null. `stackId` null
   *  is an empty layout (a new stack). */
  | { kind: 'stack-slot'; workspaceId: string; layoutId: LayoutId; stackId: StackId | null; after: PanelId | null }
  /** Among the panels of a canvas (a new node). `order` is the list order the
   *  drop leaves, kept in client state. */
  | { kind: 'canvas-slot'; workspaceId: string; canvasPanelId: PanelId; after: PanelId | null; order: PanelId[] }
  | { kind: 'detach'; screen: Point }

export interface DragState {
  isDragging: boolean
  source: DragSource | null
  panel: DragPanel | null
  /** Canvas-space offset from the ghost's top-left to the grab point. */
  grab: Point | null
  /** Canvas-space size the dropped node gets. */
  ghostSize: Size | null
  /** The source canvas's zoom at the start (1 off a canvas). Frozen so the
   *  ghost does not change size as the cursor crosses zones. */
  ghostZoom: number
  cursor: { client: Point; screen: Point; insideWindow: boolean } | null
  target: DropTarget | null
  /** Set while the cursor is outside this window and the shell shows the
   *  native ghost. */
  crossWindow: CrossWindowDrag | null
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
  crossWindow: null,
}

/** What a view hands `handleDragStart`. */
export type DragOpSourceSpec =
  | {
      kind: 'canvas-node'
      workspaceId: string
      canvasId: string
      nodeId: string
      panelId: PanelId
      startOrigin?: Point
      members?: { nodeId: string; startOrigin: Point }[]
    }
  | {
      kind: 'dock-tab'
      workspaceId: string
      dock: DockRef
      host: HostRef
      stackId: StackId
      panelId: PanelId
      from?: 'sidebar'
    }
  | {
      kind: 'layout'
      workspaceId: string
      from?: 'sidebar'
      host: HostRef
      layoutId: LayoutId
      /** One of the layout's panels, which stands for it in the ghost. */
      panelId: PanelId
    }

export type DragEvent =
  | {
      type: 'START'
      source: DragSource
      panel: DragPanel
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
      /** Built by the caller on the inside-to-outside crossing, when the drag
       *  may leave the window. */
      crossWindow?: CrossWindowDrag | null
    }
  | { type: 'TARGET'; target: DropTarget | null }
  | { type: 'END' }
  | { type: 'CANCEL' }

export type DragEffect =
  | { kind: 'set-body-class'; cls: string; on: boolean }
  | { kind: 'cross-window-start'; drag: CrossWindowDrag; screen: Point }
  | { kind: 'cross-window-cancel'; drag: CrossWindowDrag }
  | { kind: 'commit'; source: DragSource; target: DropTarget; panel: DragPanel }

export interface RuntimeState {
  state: DragState
  armed: boolean
  /** The shell shows the native ghost. */
  crossWindowActive: boolean
  /** Effects of the last step; the dispatcher drains them. */
  effects: DragEffect[]
}

export const INITIAL_RUNTIME_STATE: RuntimeState = {
  state: INITIAL_DRAG_STATE,
  armed: false,
  crossWindowActive: false,
  effects: [],
}
