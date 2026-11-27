// What the draw tool does to the document: a finished stroke goes into the
// session's drawing (one batch: its strokes and the node rect that grows to
// hold them), or starts a new drawing when the session has none yet; the
// eraser removes the strokes it touches from any drawing on the canvas, and a
// drawing left empty goes away.

import { documentStoreFor, clientStateFor } from '@client/document'
import { closePanels } from '@client/host'
import {
  DRAWING_FRAME_FIELD, DRAWING_STROKES_FIELD, addStroke, drawingFrame, drawingStrokes, hitsStroke, strokesToJson,
  type DrawingPoint, type Stroke,
} from '@panels/drawing/contract'
import { canvasViewFor, createPanelOnCanvas } from '../../client/layout/canvas'
import { useDrawState } from './drawState'

/** The session's drawing on this canvas, when it is still there. */
function sessionDrawing(workspaceId: string, canvasId: string) {
  const session = useDrawState.getState().session
  if (!session || session.workspaceId !== workspaceId || session.canvasId !== canvasId) return null
  const record = documentStoreFor(workspaceId)?.getSnapshot().panels[session.panelId]
  const state = canvasViewFor(workspaceId, canvasId)?.getState()
  const nodeId = record && state ? state.nodeForPanel(record.id) : null
  const node = nodeId ? state?.nodes[nodeId] : undefined
  return record && nodeId && node ? { record, nodeId, rect: { origin: node.origin, size: node.size } } : null
}

/** Adds a stroke drawn in canvas coordinates to the session's drawing. */
export function commitStroke(workspaceId: string, canvasId: string, canvasPanelId: string, stroke: Stroke): void {
  const current = sessionDrawing(workspaceId, canvasId)
  if (current) {
    const next = addStroke(drawingStrokes(current.record), drawingFrame(current.record), current.rect, stroke)
    documentStoreFor(workspaceId)?.propose({
      kind: 'batch',
      changes: [
        { kind: 'updatePanel', id: current.record.id, patch: { fields: { [DRAWING_STROKES_FIELD]: strokesToJson(next.strokes), [DRAWING_FRAME_FIELD]: { ...next.frame } } } },
        { kind: 'setNodeRects', canvasId, rects: [{ nodeId: current.nodeId, rect: next.rect }] },
      ],
    })
    return
  }
  const next = addStroke([], null, null, stroke)
  const panelId = createPanelOnCanvas(workspaceId, canvasId, 'drawing', {
    position: next.rect.origin,
    exact: true,
    size: next.rect.size,
    focus: false,
    strokes: strokesToJson(next.strokes),
    frame: { ...next.frame },
  })
  if (panelId) {
    useDrawState.getState().setSession({ workspaceId, canvasId, panelId })
    // Drawing keeps the canvas as the focused panel, not the new drawing.
    clientStateFor(workspaceId)?.focus(canvasPanelId)
  }
}

/** Removes the strokes within `radius` (canvas units) of `point` from every
 *  drawing on the canvas. */
export function eraseAt(workspaceId: string, canvasId: string, point: DrawingPoint, radius: number): void {
  const document = documentStoreFor(workspaceId)
  const state = canvasViewFor(workspaceId, canvasId)?.getState()
  if (!document || !state) return
  const emptied: string[] = []
  for (const record of Object.values(document.getSnapshot().panels)) {
    if (record.type !== 'drawing') continue
    const nodeId = state.nodeForPanel(record.id)
    const node = nodeId ? state.nodes[nodeId] : undefined
    if (!node) continue
    const space = drawingFrame(record) ?? node.size
    const sx = node.size.width / space.width
    const sy = node.size.height / space.height
    const local = { x: (point.x - node.origin.x) / sx, y: (point.y - node.origin.y) / sy }
    const r = radius / ((sx + sy) / 2)
    if (local.x < -r || local.y < -r || local.x > space.width + r || local.y > space.height + r) continue
    const strokes = drawingStrokes(record)
    const kept = strokes.filter((stroke) => !hitsStroke(stroke, local, r))
    if (kept.length === strokes.length) continue
    if (kept.length === 0) emptied.push(record.id)
    else document.propose({ kind: 'updatePanel', id: record.id, patch: { fields: { [DRAWING_STROKES_FIELD]: strokesToJson(kept) } } })
  }
  if (emptied.length > 0) void closePanels(workspaceId, emptied)
}
