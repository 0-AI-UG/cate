// Where a new panel goes when its options name no explicit target. One rule
// for the runtime's panel factory and client-side creation. Pure.

import { findFreePosition, nudgeToFree } from '@workspace/canvas/contract'
import {
  MAIN_WINDOW,
  canvasPanelOf,
  isCanvasDock,
  placementOf,
  stacksIn,
  type PlaceTarget,
  type WorkspaceDocument,
} from '@workspace/document/contract'
import type { AnyPanelDefinition, PanelPlacementOptions } from './definition'

/** Next to `near` (on its canvas, onto the canvas it shows, or after it in
 *  its stack), else the first stack of the main window. */
export function placeTargetFor(
  doc: WorkspaceDocument,
  definition: AnyPanelDefinition,
  placement: PanelPlacementOptions,
  makeId: () => string,
): PlaceTarget {
  if (placement.at) return placement.at
  const nearId = placement.near
  const nearRecord = nearId ? doc.panels[nearId] : undefined
  const onCanvas = (canvasId: string, beside: string | null): PlaceTarget | null => {
    const canvas = doc.canvases[canvasId]
    if (!canvas || !definition.canLiveOnCanvas) return null
    const size = definition.defaultSize
    const origin = placement.position
      ? nudgeToFree(canvas.nodes, size, placement.position)
      : findFreePosition(canvas.nodes, beside, size)
    return { to: 'canvas', canvasId: canvas.id, nodeId: makeId(), stackId: makeId(), rect: { origin, size } }
  }
  // A canvas panel as `near` means "on that canvas".
  if (nearRecord?.canvasId) {
    const target = onCanvas(nearRecord.canvasId, null)
    if (target) return target
  }
  let near = nearId ? placementOf(doc, nearId) : null
  let after = nearId
  if (near && isCanvasDock(near.dock)) {
    const target = onCanvas(near.dock.canvasId, near.dock.nodeId)
    if (target) return target
    // A panel that cannot sit on a canvas goes next to the canvas panel.
    const host = canvasPanelOf(doc, near.dock.canvasId)
    near = host ? placementOf(doc, host.id) : null
    after = host?.id
  }
  if (near) return { to: 'stack', dock: near.dock, stackId: near.stackId, after }
  const main = { windowId: MAIN_WINDOW }
  const first = stacksIn(doc, main)[0]
  return first ? { to: 'stack', dock: main, stackId: first.id } : { to: 'stack', dock: main, stackId: makeId() }
}
