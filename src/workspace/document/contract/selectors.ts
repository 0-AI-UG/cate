// Read-side queries the client mirror and the layout views use.

import { dockPanels, dockStacks, type DockStack } from './dock'
import type { DockRef } from './ops'
import { docIndex, dockOf, isCanvasDock, placementOf } from './placement'
import type { CanvasId, PanelId, PanelRecord, WindowId, WorkspaceDocument } from './schema'

type Doc = WorkspaceDocument

/** Panels on a canvas, node by node in tree order. */
export function panelsOnCanvas(doc: Doc, canvasId: CanvasId): PanelId[] {
  const canvas = doc.canvases[canvasId]
  if (!canvas) return []
  return Object.values(canvas.nodes).flatMap((node) => dockPanels(node.dock))
}

/** Panels a window shows: its dock's tabs, and the panels on every canvas
 *  whose canvas panel sits in that dock. */
export function panelsInWindow(doc: Doc, windowId: WindowId): PanelId[] {
  const window = doc.windows[windowId]
  if (!window) return []
  const out: PanelId[] = []
  for (const id of dockPanels(window.dock)) {
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
    for (const stack of dockStacks(window.dock)) out.push({ dock: { windowId: window.id }, stack })
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
