// The placement index: where every panel, stack, split and node is. Derived
// from the document and never stored, so it cannot disagree with it. Cached
// per document object (documents are immutable).

import { visitDock, type DockNode } from './dock'
import type { DockRef } from './ops'
import type {
  CanvasId,
  NodeId,
  PanelId,
  SplitId,
  StackId,
  WorkspaceDocument,
} from './schema'

export interface Placement {
  dock: DockRef
  stackId: StackId
  /** Tab index in the stack. */
  index: number
}

export interface DocIndex {
  placements: ReadonlyMap<PanelId, Placement>
  stacks: ReadonlyMap<StackId, DockRef>
  splits: ReadonlyMap<SplitId, DockRef>
  nodes: ReadonlyMap<NodeId, CanvasId>
  /** The canvas panel showing each canvas. */
  canvasPanels: ReadonlyMap<CanvasId, PanelId>
}

const cache = new WeakMap<WorkspaceDocument, DocIndex>()

export function docIndex(doc: WorkspaceDocument): DocIndex {
  let index = cache.get(doc)
  if (!index) {
    index = buildIndex(doc)
    cache.set(doc, index)
  }
  return index
}

function buildIndex(doc: WorkspaceDocument): DocIndex {
  const placements = new Map<PanelId, Placement>()
  const stacks = new Map<StackId, DockRef>()
  const splits = new Map<SplitId, DockRef>()
  const nodes = new Map<NodeId, CanvasId>()
  const canvasPanels = new Map<CanvasId, PanelId>()

  const add = (root: DockNode | null, dock: DockRef) => {
    visitDock(root, (node) => {
      if (node.kind === 'split') {
        splits.set(node.id, dock)
        return
      }
      stacks.set(node.id, dock)
      node.panels.forEach((panelId, index) => placements.set(panelId, { dock, stackId: node.id, index }))
    })
  }
  for (const window of Object.values(doc.windows)) add(window.dock, { windowId: window.id })
  for (const canvas of Object.values(doc.canvases)) {
    for (const node of Object.values(canvas.nodes)) {
      nodes.set(node.id, canvas.id)
      add(node.dock, { canvasId: canvas.id, nodeId: node.id })
    }
  }
  for (const panel of Object.values(doc.panels)) {
    if (panel.type === 'canvas' && panel.canvasId) canvasPanels.set(panel.canvasId, panel.id)
  }
  return { placements, stacks, splits, nodes, canvasPanels }
}

/** Where a panel is placed, or null for an unknown panel. */
export function placementOf(doc: WorkspaceDocument, panelId: PanelId): Placement | null {
  return docIndex(doc).placements.get(panelId) ?? null
}

export function isCanvasDock(dock: DockRef): dock is { canvasId: CanvasId; nodeId: NodeId } {
  return 'canvasId' in dock
}

export function sameDockRef(a: DockRef, b: DockRef): boolean {
  if (isCanvasDock(a)) return isCanvasDock(b) && a.canvasId === b.canvasId && a.nodeId === b.nodeId
  return !isCanvasDock(b) && a.windowId === b.windowId
}

/** The tree of a dock; undefined when its window or node does not exist,
 *  null for an empty main window. */
export function dockOf(doc: WorkspaceDocument, dock: DockRef): DockNode | null | undefined {
  if (isCanvasDock(dock)) return doc.canvases[dock.canvasId]?.nodes[dock.nodeId]?.dock
  return doc.windows[dock.windowId]?.dock
}
