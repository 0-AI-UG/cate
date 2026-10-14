// Read-side queries the client mirror and the layout views use.

import { dockPanels, dockStacks, type DockStack } from './dock'
import type { DockRef } from './ops'
import { docIndex, dockOf, hostOf, isNodeHost, placementOf } from './placement'
import { MAIN_WINDOW, type CanvasId, type CanvasNode, type NodeId, type DocWindow, type HostRef, type LayoutId, type PanelId, type PanelRecord, type WindowId, type WorkspaceDocument } from './schema'

type Doc = WorkspaceDocument

/** Panels on a canvas, node by node in tree order. */
export function panelsOnCanvas(doc: Doc, canvasId: CanvasId): PanelId[] {
  const canvas = doc.canvases[canvasId]
  if (!canvas) return []
  return Object.values(canvas.nodes).flatMap(nodePanels)
}

/** Panels in every layout of a canvas node. */
export function nodePanels(node: CanvasNode): PanelId[] {
  return node.layouts.flatMap((layout) => dockPanels(layout.dock))
}

/** A window's dock for new panels: the layout `preferred` names when it
 *  exists, else the window's first. */
export function windowDock(doc: Doc, windowId: WindowId, preferred?: LayoutId | null): DockRef {
  const layouts = doc.windows[windowId]?.layouts ?? []
  const layout = layouts.find((l) => l.id === preferred) ?? layouts[0]
  return { layoutId: layout?.id ?? '' }
}

/** The main window's dock for new panels (see windowDock). */
export function mainDock(doc: Doc, preferred?: LayoutId | null): DockRef {
  return windowDock(doc, MAIN_WINDOW, preferred)
}

/** The panels in the docks of every layout of a window (not those on canvases). */
export function windowDockPanels(window: DocWindow | undefined): PanelId[] {
  return window ? window.layouts.flatMap((layout) => dockPanels(layout.dock)) : []
}

/** Panels one layout holds: its tabs and the panels on every canvas whose
 *  canvas panel sits in it. */
export function panelsInLayout(doc: Doc, layoutId: LayoutId): PanelId[] {
  const out: PanelId[] = []
  for (const id of dockPanels(dockOf(doc, { layoutId }))) {
    out.push(id)
    const canvasId = doc.panels[id]?.canvasId
    if (canvasId) out.push(...panelsOnCanvas(doc, canvasId))
  }
  return out
}

/** Panels a window holds: its layouts' tabs (the active layout's and the
 *  others'), and the panels on every canvas whose canvas panel sits in one. */
export function panelsInWindow(doc: Doc, windowId: WindowId): PanelId[] {
  const window = doc.windows[windowId]
  if (!window) return []
  const out: PanelId[] = []
  for (const id of windowDockPanels(window)) {
    out.push(id)
    const canvasId = doc.panels[id]?.canvasId
    if (canvasId) out.push(...panelsOnCanvas(doc, canvasId))
  }
  return out
}

/** The canvas panel showing a canvas. */
export function canvasPanelOf(doc: Doc, canvasId: CanvasId): PanelRecord | null {
  const id = docIndex(doc).canvasPanels.get(canvasId)
  return id ? doc.panels[id] ?? null : null
}

/** The canvas a panel sits on, or null for a panel in a window dock. */
export function canvasOf(doc: Doc, panelId: PanelId): CanvasId | null {
  const host = hostOfPanel(doc, panelId)
  return host && isNodeHost(host) ? host.canvasId : null
}

/** The host a panel is placed in. */
export function hostOfPanel(doc: Doc, panelId: PanelId): HostRef | null {
  const dock = placementOf(doc, panelId)?.dock
  return (dock && hostOf(doc, dock.layoutId)) || null
}

/** The canvas node a panel sits in, or null for a panel in a window dock. */
export function nodeOfPanel(doc: Doc, panelId: PanelId): { canvasId: CanvasId; nodeId: NodeId } | null {
  const host = hostOfPanel(doc, panelId)
  return host && isNodeHost(host) ? host : null
}

/** The window layout a panel shows in: its own layout, or the layout of the
 *  canvas panel whose canvas it sits on (a canvas panel is never in a node, so
 *  that is one hop). Null for an unplaced panel. */
export function layoutOf(doc: Doc, panelId: PanelId): { windowId: WindowId; layoutId: string } | null {
  const host = hostOfPanel(doc, panelId)
  if (!host) return null
  if (!isNodeHost(host)) return { windowId: host.windowId, layoutId: placementOf(doc, panelId)!.dock.layoutId }
  const canvasPanel = canvasPanelOf(doc, host.canvasId)
  return canvasPanel ? layoutOf(doc, canvasPanel.id) : null
}

/** The window a panel shows in: its own window, or the window of the canvas
 *  panel whose canvas it sits on. */
export function windowOf(doc: Doc, panelId: PanelId): WindowId | null {
  return layoutOf(doc, panelId)?.windowId ?? null
}

/** The stacks of one dock, in tree order. */
export function stacksIn(doc: Doc, dock: DockRef): DockStack[] {
  return dockStacks(dockOf(doc, dock))
}

/** Every stack in the document with its dock: windows first, then canvas
 *  nodes. */
export function allStacks(doc: Doc): { dock: DockRef; stack: DockStack }[] {
  const out: { dock: DockRef; stack: DockStack }[] = []
  for (const window of Object.values(doc.windows)) {
    for (const layout of window.layouts) {
      for (const stack of dockStacks(layout.dock)) out.push({ dock: { layoutId: layout.id }, stack })
    }
  }
  for (const canvas of Object.values(doc.canvases)) {
    for (const node of Object.values(canvas.nodes)) {
      for (const layout of node.layouts) {
        for (const stack of dockStacks(layout.dock)) out.push({ dock: { layoutId: layout.id }, stack })
      }
    }
  }
  return out
}

/** Every placed panel in document order: window docks, then canvases. A
 *  canvas panel always comes before the panels on its canvas. */
export function documentOrder(doc: Doc): PanelId[] {
  return allStacks(doc).flatMap(({ stack }) => stack.panels)
}
