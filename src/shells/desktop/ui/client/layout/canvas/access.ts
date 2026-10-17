// Finding and acting on a workspace's canvases from outside a canvas view:
// shortcuts, the command palette, the drag layer, the `cate` responders.

import { clientStateFor, documentStoreFor, type ClientState } from '@client/document'
import { activeLayoutOf } from '@client/host'
import type { Point, Size } from '@workspace/canvas/contract'
import {
  MAIN_WINDOW,
  canvasOf,
  dockPanels,
  layoutById,
  type CanvasId,
  type NodeId,
  type PanelId,
  type WindowId,
  type WorkspaceDocument,
} from '@workspace/document/contract'
import { canvasViewFor } from './registry'

/** The first canvas whose canvas panel sits in the layout the window shows (tree
 *  order); a canvas in a layout this client does not show is never the primary. */
export function primaryCanvasId(doc: WorkspaceDocument, activeLayouts: ClientState['activeLayouts'], windowId: WindowId = MAIN_WINDOW): CanvasId | null {
  const shown = layoutById(doc, activeLayoutOf(doc, activeLayouts, { windowId }))
  for (const id of dockPanels(shown?.dock)) {
    const canvasId = doc.panels[id]?.canvasId
    if (canvasId && doc.canvases[canvasId]) return canvasId
  }
  return null
}

/** The canvas keyboard and creation actions act on: the focused panel's own
 *  canvas (a canvas panel, or a panel on a canvas), else the primary one. */
export function activeCanvasId(workspaceId: string, windowId: WindowId = MAIN_WINDOW): CanvasId | null {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  if (!doc) return null
  const state = clientStateFor(workspaceId)?.getSnapshot()
  const focused = state?.focusedPanelId
  if (focused && doc.panels[focused]) {
    const own = doc.panels[focused].canvasId
    if (own && doc.canvases[own]) return own
    const host = canvasOf(doc, focused)
    if (host) return host
  }
  return primaryCanvasId(doc, state?.activeLayouts ?? {}, windowId)
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
