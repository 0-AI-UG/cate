// workspace/canvas: the canvas model. Canvases, nodes and their geometry,
// free-slot placement, arrangement and snapping. Pure; the document reducer
// and the client's optimistic mirror both run it. The client draws it
// (client/layout/canvas).

import type { CanvasId, DockNode, NodeId } from '@workspace/document/contract'
import type { Rect } from './contract/geometry'

export * from './contract/geometry'
export * from './contract/placement'
export * from './contract/arrange'

export interface CanvasNode {
  id: NodeId
  rect: Rect
  /** The node's mini dock; never empty (an emptied node is removed). */
  dock: DockNode
}

export interface CanvasModel {
  id: CanvasId
  /** In creation order: the last node is the newest. Stacking order is
   *  client state. */
  nodes: Record<NodeId, CanvasNode>
}
