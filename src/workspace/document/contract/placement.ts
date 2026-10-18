// The placement index: where every panel, stack, split and node is. Derived
// from the document and never stored, so it cannot disagree with it. Cached
// per document object (documents are immutable).

import { visitDock, type DockNode } from './dock'
import type { DockRef } from './ops'
import type {
  CanvasId,
  DockLayout,
  HostRef,
  LayoutId,
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
  /** The host of every layout. */
  layouts: ReadonlyMap<LayoutId, HostRef>
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
  const layouts = new Map<LayoutId, HostRef>()
  const canvasPanels = new Map<CanvasId, PanelId>()

  const add = (layout: DockLayout, host: HostRef) => {
    const dock: DockRef = { layoutId: layout.id }
    layouts.set(layout.id, host)
    visitDock(layout.dock, (node) => {
      if (node.kind === 'split') {
        splits.set(node.id, dock)
        return
      }
      stacks.set(node.id, dock)
      node.panels.forEach((panelId, index) => placements.set(panelId, { dock, stackId: node.id, index }))
    })
  }
  for (const window of Object.values(doc.windows)) {
    for (const layout of window.layouts) add(layout, { windowId: window.id })
  }
  for (const canvas of Object.values(doc.canvases)) {
    for (const node of Object.values(canvas.nodes)) {
      nodes.set(node.id, canvas.id)
      for (const layout of node.layouts) add(layout, { canvasId: canvas.id, nodeId: node.id })
    }
  }
  for (const panel of Object.values(doc.panels)) {
    if (panel.canvasId) canvasPanels.set(panel.canvasId, panel.id)
  }
  return { placements, stacks, splits, nodes, layouts, canvasPanels }
}

/** Where a panel is placed, or null for an unknown panel. */
export function placementOf(doc: WorkspaceDocument, panelId: PanelId): Placement | null {
  return docIndex(doc).placements.get(panelId) ?? null
}

export function isNodeHost(host: HostRef): host is { canvasId: CanvasId; nodeId: NodeId } {
  return 'canvasId' in host
}

/** The id that names a host in client state: its window id or its node id. */
export function hostKey(host: HostRef): string {
  return isNodeHost(host) ? host.nodeId : host.windowId
}

export function sameHost(a: HostRef, b: HostRef): boolean {
  if (isNodeHost(a)) return isNodeHost(b) && a.canvasId === b.canvasId && a.nodeId === b.nodeId
  return !isNodeHost(b) && a.windowId === b.windowId
}

export function sameDockRef(a: DockRef, b: DockRef): boolean {
  return a.layoutId === b.layoutId
}

/** The host of a layout, or undefined when there is no such layout. */
export function hostOf(doc: WorkspaceDocument, layoutId: LayoutId): HostRef | undefined {
  return docIndex(doc).layouts.get(layoutId)
}

/** The layouts of a host in switcher order; undefined when it does not exist. */
export function layoutsIn(doc: WorkspaceDocument, host: HostRef): DockLayout[] | undefined {
  if (isNodeHost(host)) return doc.canvases[host.canvasId]?.nodes[host.nodeId]?.layouts
  return doc.windows[host.windowId]?.layouts
}

/** A layout, or undefined when there is no such layout. */
export function layoutById(doc: WorkspaceDocument, layoutId: LayoutId): DockLayout | undefined {
  const host = hostOf(doc, layoutId)
  return host && layoutsIn(doc, host)?.find((l) => l.id === layoutId)
}

/** Whether a dock sits in a canvas node. */
export function isCanvasDock(doc: WorkspaceDocument, dock: DockRef): boolean {
  const host = hostOf(doc, dock.layoutId)
  return !!host && isNodeHost(host)
}

/** The tree of a dock; undefined when its layout does not exist, null for an
 *  empty layout. */
export function dockOf(doc: WorkspaceDocument, dock: DockRef): DockNode | null | undefined {
  return layoutById(doc, dock.layoutId)?.dock
}
