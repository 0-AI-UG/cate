// Finding and acting on a workspace's canvases from outside a canvas view:
// shortcuts, the command palette, the drag layer, the `cate` responders.

import { clientStateFor, documentStoreFor } from '@client/document'
import type { Point, Size } from '@workspace/canvas/contract'
import {
  MAIN_WINDOW,
  canvasOf,
  dockPanels,
  type CanvasId,
  type NodeId,
  type PanelId,
  type WindowId,
  type WorkspaceDocument,
  windowDockPanels,
} from '@workspace/document/contract'
import { canvasViewFor } from './registry'

/** The first canvas whose canvas panel sits in the window's dock (tree
 *  order), else any canvas. */
export function primaryCanvasId(doc: WorkspaceDocument, windowId: WindowId = MAIN_WINDOW): CanvasId | null {
  for (const id of windowDockPanels(doc.windows[windowId])) {
    const canvasId = doc.panels[id]?.canvasId
    if (canvasId && doc.canvases[canvasId]) return canvasId
  }
  return Object.keys(doc.canvases)[0] ?? null
}

/** The canvas keyboard and creation actions act on: the focused panel's own
 *  canvas (a canvas panel, or a panel on a canvas), else the primary one. */
export function activeCanvasId(workspaceId: string, windowId: WindowId = MAIN_WINDOW): CanvasId | null {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  if (!doc) return null
  const focused = clientStateFor(workspaceId)?.getSnapshot().focusedPanelId
  if (focused && doc.panels[focused]) {
    const own = doc.panels[focused].canvasId
    if (own && doc.canvases[own]) return own
    const host = canvasOf(doc, focused)
    if (host) return host
  }
  return primaryCanvasId(doc, windowId)
}

/** Moves a placed panel onto a canvas as a new node (a drop onto a canvas).
 *  With `exact` the node lands at `position` as given. */
export function placePanelOnCanvas(
  workspaceId: string,
  canvasId: CanvasId,
  panelId: PanelId,
  options: { position?: Point; size?: Size; exact?: boolean; focus?: boolean } = {},
): NodeId | null {
  const store = canvasViewFor(workspaceId, canvasId)
  return store ? store.getState().placePanel(panelId, options) : null
}
