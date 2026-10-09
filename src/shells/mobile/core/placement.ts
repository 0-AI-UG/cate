// Where the app puts a new panel (`MobilePlacement`): in the dock when it
// names none, else on a canvas panel's canvas, centred on the point the
// person picked or where there is room. The spots it offers are the
// desktop's recommended ones (`recommendPlacements`).

import { panelDefinition } from '@client/host'
import type { PanelPlacementOptions } from '@panels/framework/contract'
import { originCentredOn, recommendPlacements } from '@workspace/canvas/contract'
import type { WorkspaceDocument } from '@workspace/document/contract'
import type { MobileCanvasRect, MobilePlacement } from '../contract'

/** The desktop's size for a type that names none. */
const FALLBACK_SIZE = { width: 640, height: 400 }

/** The create options of a new panel of `type` placed at `placement`. */
export function placementOptions(type: string, placement: MobilePlacement | null | undefined): PanelPlacementOptions {
  if (!placement) return {}
  const size = placement.size ?? panelDefinition(type)?.defaultSize
  const at = placement.point
  const position = at && size ? originCentredOn(at, size) : undefined
  return { near: placement.canvasPanelId, ...(position ? { position } : {}), ...(placement.size ? { size: placement.size } : {}) }
}

/** The spots a new panel of `type` could take on the canvas `canvasPanelId`
 *  shows, best first, for the part of it on screen. */
export function suggestPlacements(
  doc: WorkspaceDocument,
  canvasPanelId: string,
  type: string,
  visible: MobileCanvasRect,
): MobileCanvasRect[] {
  const canvasId = doc.panels[canvasPanelId]?.canvasId
  const canvas = canvasId ? doc.canvases[canvasId] : undefined
  if (!canvas) return []
  const size = panelDefinition(type)?.defaultSize ?? FALLBACK_SIZE
  // The visible rect as a viewport at zoom 1.
  const viewport = { offset: { x: -visible.x, y: -visible.y }, zoom: 1, containerSize: { width: visible.width, height: visible.height } }
  return recommendPlacements(canvas.nodes, null, size, viewport, null).map(({ point, size }) => ({
    x: point.x,
    y: point.y,
    width: size.width,
    height: size.height,
  }))
}
