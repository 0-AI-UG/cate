// A resolved drop to document changes. Every drop is one op (13.5): the drag
// shows only a ghost while it runs, and the release sends the placement.

import {
  canvasOf,
  dockOf,
  dockPanels,
  dockStacks,
  findStack,
  layoutById,
  layoutsIn,
  placementOf,
  sameDockRef,
  type DocChange,
  type WorkspaceDocument,
} from '@workspace/document/contract'
import { findFreePosition, type Point, type Rect, type Size } from '@workspace/canvas/contract'
import { canLiveOnCanvas, panelDropSize } from '@client/host'
import type { DragPanel, DragSource, DropTarget } from './types'

export interface DropContext {
  newId(): string
  /** The active tab of a stack (client state); the first panel by default. */
  activeOf?(stack: { id: string; panels: string[] }): string
}

/** The panels of a moved layout that are hidden behind a stack's active tab,
 *  each as its own pane beside the stack (or the pane before it). Computed from
 *  the document before the move; stack ids do not change on move. */
export function expandHiddenTabs(doc: WorkspaceDocument, layoutId: string, ctx: DropContext): DocChange[] {
  const layout = layoutById(doc, layoutId)
  if (!layout) return []
  const out: DocChange[] = []
  for (const stack of dockStacks(layout.dock)) {
    const active = ctx.activeOf?.(stack) ?? stack.panels[0]
    let beside = stack.id
    for (const panelId of stack.panels) {
      if (panelId === active) continue
      const stackId = ctx.newId()
      out.push({ kind: 'placePanel', id: panelId, at: { to: 'split', dock: { layoutId }, beside, side: 'right', stackId, splitId: ctx.newId() } })
      beside = stackId
    }
  }
  return out
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
      // A layout moves whole, keeping its panels and its name.
      if (source.origin.kind === 'layout') {
        return [{ kind: 'moveLayout', layoutId: source.origin.layoutId, to: { to: 'canvas', canvasId: target.canvasId, nodeId: ctx.newId(), rect: { origin: target.origin, size: target.size } } }]
      }
      return [{
        kind: 'placePanel',
        id: panel.id,
        at: { to: 'canvas', canvasId: target.canvasId, nodeId: ctx.newId(), layoutId: ctx.newId(), stackId: ctx.newId(), rect: { origin: target.origin, size: target.size } },
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

    case 'tab-slot': {
      const layouts = layoutsIn(doc, target.host)
      if (!layouts) return null
      // A layout (dragged whole, or a tab on its own) moves keeping its id and
      // name, within this host or from another window. A canvas node's layout
      // moves whole too (a group move only if it holds one panel), and its
      // hidden tabs become panes beside their stacks.
      const layoutId = source.origin.kind === 'layout' ? source.origin.layoutId : placementOf(doc, panel.id)?.dock.layoutId
      const moved = layoutId ? layoutById(doc, layoutId) : undefined
      const wholeNode = source.origin.kind === 'canvas-node' && !source.origin.members?.length
      if (layoutId && moved && (source.origin.kind === 'layout' || wholeNode || dockPanels(moved.dock).length === 1)) {
        const from = layouts.findIndex((l) => l.id === layoutId)
        // Slots count the layouts as they stand; the dragged one leaves its
        // place first, which shifts every slot after it.
        const index = from >= 0 && target.index > from ? target.index - 1 : target.index
        if (index === from) return null
        const move: DocChange = { kind: 'moveLayout', layoutId, to: { to: 'host', host: target.host, index } }
        return wholeNode ? [move, ...expandHiddenTabs(doc, layoutId, ctx)] : [move]
      }
      return [{ kind: 'placePanel', id: panel.id, at: { to: 'tab', host: target.host, layoutId: ctx.newId(), stackId: ctx.newId(), index: target.index } }]
    }

    case 'group-home':
      return null

    case 'group-slot': {
      const dock = { layoutId: target.layoutId }
      const tree = dockOf(doc, dock)
      const beside = tree && findStack(tree, target.beside)
      if (!beside) return null
      // Beside its own lone pane is where it already is.
      if (placementOf(doc, panel.id)?.stackId === target.beside && beside.panels.length <= 1) return null
      return [{ kind: 'placePanel', id: panel.id, at: { to: 'split', dock, beside: target.beside, side: target.side, stackId: ctx.newId(), splitId: ctx.newId() } }]
    }

    case 'stack-slot': {
      const placement = placementOf(doc, panel.id)
      if (!placement) return null
      const dock = { layoutId: target.layoutId }
      // Its own spot is where it already is.
      if (target.stackId !== null && placement.stackId === target.stackId && sameDockRef(placement.dock, dock)) {
        const panels = findStack(dockOf(doc, dock), target.stackId)?.panels ?? []
        if ((panels[panels.indexOf(panel.id) - 1] ?? null) === target.after) return null
      }
      return [{ kind: 'placePanel', id: panel.id, at: { to: 'stack', dock, stackId: target.stackId ?? ctx.newId(), after: target.after } }]
    }

    case 'canvas-slot': {
      const canvasId = doc.panels[target.canvasPanelId]?.canvasId
      const canvas = canvasId ? doc.canvases[canvasId] : undefined
      if (!canvasId || !canvas || !placementOf(doc, panel.id)) return null
      // Within its own canvas the order of nodes is nothing the canvas keeps.
      if (canvasOf(doc, panel.id) === canvasId) return null
      if (!canLiveOnCanvas(panel.type)) return null
      const size = panelDropSize(panel.type)
      const origin = findFreePosition(canvas.nodes, null, size)
      return [{ kind: 'placePanel', id: panel.id, at: { to: 'canvas', canvasId, nodeId: ctx.newId(), layoutId: ctx.newId(), stackId: ctx.newId(), rect: { origin, size } } }]
    }

    case 'detach':
      return null
  }
}

/** The op that detaches a panel into the new window `windowId`. */
export function detachChange(panel: DragPanel, windowId: string, newId: () => string): DocChange {
  return { kind: 'placePanel', id: panel.id, at: { to: 'window', windowId, layoutId: newId(), stackId: newId() } }
}

/** Where the detached window opens on this device: at the drop point. */
export function detachBounds(screen: Point, grab: Point, size: Size): Rect {
  return { origin: { x: Math.round(screen.x - grab.x), y: Math.round(screen.y - grab.y) }, size: { width: Math.round(size.width), height: Math.round(size.height) } }
}
