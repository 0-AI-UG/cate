// Read-side queries the client mirror and the layout views use.

import { dockPanels, dockStacks, type DockStack } from './dock'
import type { DockRef } from './ops'
import { docIndex, dockOf, isCanvasDock, placementOf } from './placement'
import { MAIN_WINDOW, type CanvasId, type DocWindow, type LayoutId, type PanelId, type PanelRecord, type WindowId, type WorkspaceDocument } from './schema'

type Doc = WorkspaceDocument

/** Panels on a canvas, node by node in tree order. */
export function panelsOnCanvas(doc: Doc, canvasId: CanvasId): PanelId[] {
  const canvas = doc.canvases[canvasId]
  if (!canvas) return []
  return Object.values(canvas.nodes).flatMap((node) => dockPanels(node.dock))
}

/** A window's dock for new panels: the layout `preferred` names when it
 *  exists, else the window's first. */
export function windowDock(doc: Doc, windowId: WindowId, preferred?: LayoutId | null): DockRef {
  const layouts = doc.windows[windowId]?.layouts ?? []
  const layout = layouts.find((l) => l.id === preferred) ?? layouts[0]
  return { windowId, layoutId: layout?.id ?? '' }
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
export function panelsInLayout(doc: Doc, windowId: WindowId, layoutId: LayoutId): PanelId[] {
  const layout = doc.windows[windowId]?.layouts.find((l) => l.id === layoutId)
  const out: PanelId[] = []
  for (const id of dockPanels(layout?.dock)) {
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
  const dock = placementOf(doc, panelId)?.dock
  return dock && isCanvasDock(dock) ? dock.canvasId : null
}

/** The layout a panel sits in, or the layout of the canvas panel whose canvas
 *  it sits on. Null for an unplaced panel. */
export function layoutOf(doc: Doc, panelId: PanelId): { windowId: WindowId; layoutId: string } | null {
  let dock = placementOf(doc, panelId)?.dock
  if (dock && isCanvasDock(dock)) {
    const canvasPanel = canvasPanelOf(doc, dock.canvasId)
    dock = canvasPanel ? placementOf(doc, canvasPanel.id)?.dock : undefined
  }
  return dock && !isCanvasDock(dock) ? { windowId: dock.windowId, layoutId: dock.layoutId } : null
}

/** The window a panel shows in: its own window, or the window of the canvas
 *  panel whose canvas it sits on. */
export function windowOf(doc: Doc, panelId: PanelId): WindowId | null {
  const dock = placementOf(doc, panelId)?.dock
  if (!dock) return null
  if (!isCanvasDock(dock)) return dock.windowId
  const canvasPanel = canvasPanelOf(doc, dock.canvasId)
  if (!canvasPanel) return null
  const outer = placementOf(doc, canvasPanel.id)?.dock
  return outer && !isCanvasDock(outer) ? outer.windowId : null
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
      for (const stack of dockStacks(layout.dock)) out.push({ dock: { windowId: window.id, layoutId: layout.id }, stack })
    }
  }
  for (const canvas of Object.values(doc.canvases)) {
    for (const node of Object.values(canvas.nodes)) {
      for (const stack of dockStacks(node.dock)) out.push({ dock: { canvasId: canvas.id, nodeId: node.id }, stack })
    }
  }
  return out
}

/** Every placed panel in document order: window docks, then canvases. A
 *  canvas panel always comes before the panels on its canvas. */
export function documentOrder(doc: Doc): PanelId[] {
  return allStacks(doc).flatMap(({ stack }) => stack.panels)
}
