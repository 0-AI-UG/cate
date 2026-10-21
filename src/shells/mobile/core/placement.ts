// Where the app puts a new panel (`MobilePlacement`): in the dock when it
// names none, else on a canvas panel's canvas, at a planned spot, centred
// near a point or where there is room. Spots are planned as on every client
// (`planPlacement`).

import { panelDefinition } from '@client/host'
import type { PanelPlacementOptions } from '@panels/framework/contract'
import { originCentredOn, planPlacement, type Point, type Size } from '@workspace/canvas/contract'
import type { WorkspaceDocument } from '@workspace/document/contract'
import type { MobileCanvasRect, MobilePlacement, MobilePlacementPlan } from '../contract'

/** The desktop's size for a type that names none. */
const FALLBACK_SIZE = { width: 640, height: 400 }

/** The create options of a new panel of `type` placed at `placement`. */
export function placementOptions(type: string, placement: MobilePlacement | null | undefined): PanelPlacementOptions {
  if (!placement) return {}
  const near = placement.canvasPanelId
  const { spot, point } = placement
  if (spot) return { near, position: { x: spot.x, y: spot.y }, size: { width: spot.width, height: spot.height }, exact: true }
  const size = panelDefinition(type)?.defaultSize
  return point && size ? { near, position: originCentredOn(point, size) } : { near }
}

/** How a new panel of `type` gets its spot on the canvas `canvasPanelId`
 *  shows, for the part of it on screen; null without that canvas. */
export function planPlacementOn(
  doc: WorkspaceDocument,
  canvasPanelId: string,
  type: string,
  visible: MobileCanvasRect,
): MobilePlacementPlan | null {
  const canvasId = doc.panels[canvasPanelId]?.canvasId
  const canvas = canvasId ? doc.canvases[canvasId] : undefined
  if (!canvas) return null
  const size = panelDefinition(type)?.defaultSize ?? FALLBACK_SIZE
  // The visible rect as a viewport at zoom 1.
  const viewport = { offset: { x: -visible.x, y: -visible.y }, zoom: 1, containerSize: { width: visible.width, height: visible.height } }
  const plan = planPlacement(canvas.nodes, size, viewport)
  return plan.kind === 'place' ? { place: rect(plan.point, plan.size) } : { pick: plan.candidates.map((c) => rect(c.point, c.size)) }
}

function rect(point: Point, size: Size): MobileCanvasRect {
  return { x: point.x, y: point.y, width: size.width, height: size.height }
}
