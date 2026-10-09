// What the canvas uses from the rest of the client: panels (client/host) and
// dragging (ui/client/layout/drag). The drag layer defaults to ui/client/layout/drag;
// tests install their own.

import type { Point } from '@workspace/canvas/contract'
import type { AnyPanelDefinition, PanelCreateOptions } from '@panels/framework/contract'
import type { NodeId, PanelId } from '@workspace/document/contract'
import { closePanels, createPanel, creatableDefinitions, panelDefinitions } from '@client/host'
import { beginDrag, useDragStore } from '../drag'

// --- Panels ---------------------------------------------------------------------

/** Panels come from client/host: its definition index, creation and close
 *  flow. */
export interface CanvasHost {
  /** The panel index: sizes, labels, icons and `canLiveOnCanvas`. */
  definitions(): readonly AnyPanelDefinition[]
  /** The types people can create on this client, in creation order; with
   *  `onCanvas`, only those that can live on a canvas. */
  creatable(where?: { onCanvas?: boolean }): readonly AnyPanelDefinition[]
  /** Creates a panel through its definition. The canvas passes `at` (a
   *  canvas target it chose). Returns the new id, or null. */
  createPanel(workspaceId: string, type: string, options: PanelCreateOptions & Record<string, unknown>): PanelId | null
  /** Closes panels after the usual confirmations (dirty editors, running
   *  terminals). Resolves true when they were closed. */
  closePanels(workspaceId: string, panelIds: readonly PanelId[]): Promise<boolean>
}

const CLIENT_HOST: CanvasHost = {
  definitions: () => panelDefinitions(),
  creatable: (where) => creatableDefinitions(where),
  createPanel: (workspaceId, type, options) => createPanel(workspaceId, type, options),
  closePanels: (workspaceId, panelIds) => closePanels(workspaceId, panelIds),
}

export function canvasHost(): CanvasHost {
  return CLIENT_HOST
}

export function panelDefinition(type: string | undefined): AnyPanelDefinition | undefined {
  return type ? CLIENT_HOST.definitions().find((d) => d.type === type) : undefined
}

const FALLBACK_SIZE = { width: 640, height: 400 }
const FALLBACK_MIN = { width: 200, height: 120 }

export function panelDefaultSize(type: string | undefined): { width: number; height: number } {
  return panelDefinition(type)?.defaultSize ?? FALLBACK_SIZE
}

export function panelMinimumSize(type: string | undefined): { width: number; height: number } {
  return panelDefinition(type)?.minimumSize ?? FALLBACK_MIN
}

// --- Dragging --------------------------------------------------------------------

/** A whole-node drag. `members` are the other nodes of a group move. */
export interface CanvasNodeDragSource {
  workspaceId: string
  canvasId: string
  nodeId: NodeId
  /** The node's active panel, for the ghost. */
  panelId: PanelId
  startOrigin?: Point
  members?: { nodeId: NodeId; startOrigin: Point }[]
}

/** One tab dragged out of a node's mini dock. */
export interface CanvasTabDragSource {
  workspaceId: string
  canvasId: string
  nodeId: NodeId
  stackId: string
  panelId: PanelId
}

export interface CanvasDragState {
  dragging: boolean
  /** The node whose whole-node drag is showing a ghost in its place. */
  sourceNodeId: NodeId | null
  /** The ghost's canvas-space origin on the source canvas, null while the
   *  cursor is outside the window. The territory follows it. */
  ghostOrigin?: Point | null
}

/** The drag layer as the canvas sees it. The default is ui/client/layout/drag;
 *  tests install a fake. */
export interface CanvasDragPort {
  getState(): CanvasDragState
  subscribe(listener: () => void): () => void
  beginNodeDrag(event: MouseEvent, source: CanvasNodeDragSource): void
  beginTabDrag(event: MouseEvent, source: CanvasTabDragSource): void
  /** True when the last press turned into a drag, so the click after it is
   *  not a select. */
  wasDragged(): boolean
}

// The drag layer (ui/client/layout/drag) behind the port.
let lastDragState: CanvasDragState = { dragging: false, sourceNodeId: null, ghostOrigin: null }
function readDragState(): CanvasDragState {
  const s = useDragStore.getState()
  const origin = s.source?.origin
  const sourceNodeId = s.isDragging && origin?.kind === 'canvas-node' ? origin.nodeId : null
  const target = s.target
  const ghostOrigin = sourceNodeId && target?.kind === 'canvas-reposition' ? target.origin : null
  const last = lastDragState
  if (last.dragging === s.isDragging && last.sourceNodeId === sourceNodeId
    && (last.ghostOrigin === ghostOrigin || (last.ghostOrigin && ghostOrigin && last.ghostOrigin.x === ghostOrigin.x && last.ghostOrigin.y === ghostOrigin.y))) {
    return last
  }
  lastDragState = { dragging: s.isDragging, sourceNodeId, ghostOrigin }
  return lastDragState
}

// Whether the press that began last turned into a drag: set when the drag
// layer starts dragging, cleared by the next press.
let draggedSincePress = false
let watchingDrags = false
function watchDrags(): void {
  if (watchingDrags) return
  watchingDrags = true
  useDragStore.subscribe((s) => { if (s.isDragging) draggedSincePress = true })
}

const CLIENT_DRAG: CanvasDragPort = {
  getState: readDragState,
  subscribe: (listener) => useDragStore.subscribe(listener),
  beginNodeDrag: (event, source) => {
    watchDrags()
    draggedSincePress = false
    beginDrag(event, { kind: 'canvas-node', ...source })
  },
  beginTabDrag: (event, source) => {
    watchDrags()
    draggedSincePress = false
    beginDrag(event, {
      kind: 'dock-tab',
      workspaceId: source.workspaceId,
      dock: { canvasId: source.canvasId, nodeId: source.nodeId },
      stackId: source.stackId,
      panelId: source.panelId,
    })
  },
  wasDragged: () => draggedSincePress,
}

let drag: CanvasDragPort = CLIENT_DRAG
const dragListeners = new Set<() => void>()

export function installCanvasDrag(next: CanvasDragPort | null): void {
  drag = next ?? CLIENT_DRAG
  for (const listener of [...dragListeners]) listener()
}

export function canvasDrag(): CanvasDragPort {
  return drag
}

/** Fires when a different drag port is installed. */
export function subscribeCanvasDragPort(listener: () => void): () => void {
  dragListeners.add(listener)
  return () => { dragListeners.delete(listener) }
}
