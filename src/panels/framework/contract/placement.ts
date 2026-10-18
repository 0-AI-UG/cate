// Where a new panel goes when its options name no explicit target. One rule
// for the runtime's panel factory and client-side creation. Pure.

import { findFreePosition, nudgeToFree } from '@workspace/canvas/contract'
import {
  canvasPanelOf,
  nodeOfPanel,
  mainDock,
  dockOf,
  hostOf,
  layoutsIn,
  placementOf,
  type DockRef,
  type PlaceTarget,
  type WorkspaceDocument,
} from '@workspace/document/contract'
import type { AnyPanelDefinition, PanelPlacementOptions } from './definition'

/** Next to `near` (on its canvas, onto the canvas it shows, or a new tab right
 *  after its layout), else a new tab after the main window's shown layout (the
 *  layout itself when it is empty). */
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
    const size = placement.size ?? definition.defaultSize
    const origin = placement.position
      ? nudgeToFree(canvas.nodes, size, placement.position)
      : findFreePosition(canvas.nodes, beside, size)
    return { to: 'canvas', canvasId: canvas.id, nodeId: makeId(), layoutId: makeId(), stackId: makeId(), rect: { origin, size } }
  }
  // A canvas panel as `near` means "on that canvas".
  if (nearRecord?.canvasId) {
    const target = onCanvas(nearRecord.canvasId, null)
    if (target) return target
  }
  let near = nearId ? placementOf(doc, nearId) : null
  let after = nearId
  const nearNode = nearId ? nodeOfPanel(doc, nearId) : null
  if (near && nearNode) {
    const target = onCanvas(nearNode.canvasId, nearNode.nodeId)
    if (target) return target
    // A panel that cannot sit on a canvas goes next to the canvas panel.
    const host = canvasPanelOf(doc, nearNode.canvasId)
    near = host ? placementOf(doc, host.id) : null
    after = host?.id
  }
  if (near) return tabAfter(doc, near.dock, makeId)
  const main = mainDock(doc, placement.layoutId)
  return dockOf(doc, main) ? tabAfter(doc, main, makeId) : { to: 'stack', dock: main, stackId: makeId() }
}

/** A new single-panel layout right after `dock`'s, in the same host. */
function tabAfter(doc: WorkspaceDocument, dock: DockRef, makeId: () => string): PlaceTarget {
  const host = hostOf(doc, dock.layoutId)!
  const index = layoutsIn(doc, host)!.findIndex((l) => l.id === dock.layoutId) + 1
  return { to: 'tab', host, layoutId: makeId(), stackId: makeId(), index }
}
