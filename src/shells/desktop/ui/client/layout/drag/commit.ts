// A resolved drop to document changes. Every drop is one op (13.5): the drag
// shows only a ghost while it runs, and the release sends the placement.

import {
  dockOf,
  dockStacks,
  findStack,
  placementOf,
  type DocChange,
  type WorkspaceDocument,
} from '@workspace/document/contract'
import type { Point, Size } from '@workspace/canvas/contract'
import { canLiveOnCanvas } from '@client/host'
import type { DragPanel, DragSource, DropTarget } from './types'

export interface DropContext {
  newId(): string
}

/** The changes a drop makes, in order; null for a no-op or a refused drop.
 *  `detach` targets are handled by `detachChange`. */
export function dropChanges(
  doc: WorkspaceDocument,
  source: DragSource,
  target: DropTarget,
  panel: DragPanel,
  ctx: DropContext,
): DocChange[] | null {
  if (!doc.panels[panel.id]) return null
  switch (target.kind) {
    case 'canvas-reposition': {
      const canvas = doc.canvases[target.canvasId]
      const node = canvas?.nodes[target.nodeId]
      if (!node) return null
      const rects = [{ nodeId: node.id, rect: { origin: target.origin, size: node.rect.size } }]
      // A group moves every member by the anchor's (snapped) delta.
      if (source.origin.kind === 'canvas-node' && source.origin.members?.length) {
        const start = source.origin.startOrigin ?? target.origin
        const dx = target.origin.x - start.x
        const dy = target.origin.y - start.y
        for (const member of source.origin.members) {
          const other = canvas.nodes[member.nodeId]
          if (!other) continue
          rects.push({ nodeId: other.id, rect: { origin: { x: member.startOrigin.x + dx, y: member.startOrigin.y + dy }, size: other.rect.size } })
        }
      }
      return [{ kind: 'setNodeRects', canvasId: canvas.id, rects }]
    }

    case 'canvas-add': {
      if (!canLiveOnCanvas(panel.type) || !doc.canvases[target.canvasId]) return null
      return [{
        kind: 'placePanel',
        id: panel.id,
        at: { to: 'canvas', canvasId: target.canvasId, nodeId: ctx.newId(), stackId: ctx.newId(), rect: { origin: target.origin, size: target.size } },
      }]
    }

    case 'dock-zone': {
      const tree = dockOf(doc, target.dock)
      if (tree === undefined) return null
      if (target.edge && tree) {
        return [{
          kind: 'placePanel',
          id: panel.id,
          at: { to: 'split', dock: target.dock, beside: tree.id, side: target.edge, stackId: ctx.newId(), splitId: ctx.newId() },
        }]
      }
      const first = dockStacks(tree)[0]
      return [{
        kind: 'placePanel',
        id: panel.id,
        at: { to: 'stack', dock: target.dock, stackId: first?.id ?? ctx.newId() },
      }]
    }

    case 'dock-tab':
    case 'dock-split': {
      const tree = dockOf(doc, target.dock)
      if (!tree || !findStack(tree, target.stackId)) return null
      // A lone tab dropped on its own tab bar stays put.
      if (target.kind === 'dock-tab' && source.origin.kind === 'dock-tab' && source.origin.stackId === target.stackId) {
        const current = placementOf(doc, panel.id)
        const stack = findStack(tree, target.stackId)
        if (current?.stackId === target.stackId && (stack?.panels.length ?? 0) <= 1) return null
      }
      const change: DocChange = target.kind === 'dock-tab'
        ? { kind: 'placePanel', id: panel.id, at: { to: 'stack', dock: target.dock, stackId: target.stackId } }
        : { kind: 'placePanel', id: panel.id, at: { to: 'split', dock: target.dock, beside: target.stackId, side: target.edge, stackId: ctx.newId(), splitId: ctx.newId() } }
      return [change]
    }

    case 'detach':
      return null
  }
}

/** The op that detaches a panel into a new window at the drop point. The
 *  bounds are shared; each client clamps them to its screens. */
export function detachChange(panel: DragPanel, screen: Point, grab: Point, size: Size, newId: () => string): DocChange {
  return {
    kind: 'placePanel',
    id: panel.id,
    at: {
      to: 'window',
      windowId: newId(),
      stackId: newId(),
      bounds: { origin: { x: Math.round(screen.x - grab.x), y: Math.round(screen.y - grab.y) }, size: { width: Math.round(size.width), height: Math.round(size.height) } },
    },
  }
}
