// Closing a canvas panel removes the canvas and the panels on it
// (architecture 9.1), so the view asks first. With another canvas left, the
// panels can move there instead.

import { clientUi } from '@kernel/interaction'
import type { CloseGuard } from '@client/host'
import { documentStoreFor } from '@client/document'
import { placePanelOnCanvas } from '../../client/layout/canvas'
import { dockPanels, panelsOnCanvas } from '@workspace/document/contract'

export type CanvasCloseChoice = 'move' | 'delete' | 'close' | 'cancel'

declare module '@kernel/interaction/contract' {
  interface ClientUi {
    /** `move` and `delete` only when `canMove` (another canvas stays). */
    confirmCloseCanvas?(request: { panelCount: number; canMove: boolean }): Promise<CanvasCloseChoice>
  }
}

const plural = (count: number) => `${count} open ${count === 1 ? 'panel' : 'panels'}`

async function ask(panelCount: number, canMove: boolean): Promise<CanvasCloseChoice> {
  const ui = clientUi()
  if (ui.confirmCloseCanvas) return ui.confirmCloseCanvas({ panelCount, canMove })
  const message = panelCount > 0 ? `Close this canvas and its ${plural(panelCount)}?` : 'Close this canvas?'
  return (await ui.confirm(message)) ? 'close' : 'cancel'
}

export const canvasCloseGuard: CloseGuard = async ({ workspaceId, record, closing }) => {
  const store = documentStoreFor(workspaceId)
  const doc = store?.getSnapshot()
  const canvasId = record.canvasId
  if (!store || !doc || !canvasId) return true
  const contained = panelsOnCanvas(doc, canvasId)
  const target = Object.values(doc.panels).find((panel) =>
    panel.canvasId && panel.canvasId !== canvasId && !closing.has(panel.id) && doc.canvases[panel.canvasId])?.canvasId
  const choice = await ask(contained.length, !!target && contained.length > 0)
  if (choice === 'cancel') return false
  if (choice !== 'move' || !target) return true
  // Each panel lands as its own node where its node was; the close then takes
  // only the canvas, and the moved panels' own guards no longer run.
  for (const node of Object.values(doc.canvases[canvasId]?.nodes ?? {})) {
    for (const panelId of dockPanels(node.dock)) {
      placePanelOnCanvas(workspaceId, target, panelId, { position: node.rect.origin, size: node.rect.size, focus: false })
    }
  }
  return true
}
