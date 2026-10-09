// Where the app puts a new panel (`MobilePlacement`): in the dock when it
// names none, else on a canvas panel's canvas, centred on the point the
// person picked or where there is room.

import { panelDefinition } from '@client/host'
import type { PanelPlacementOptions } from '@panels/framework/contract'
import { originCentredOn } from '@workspace/canvas/contract'
import type { MobilePlacement } from '../contract'

/** The create options of a new panel of `type` placed at `placement`. */
export function placementOptions(type: string, placement: MobilePlacement | null | undefined): PanelPlacementOptions {
  if (!placement) return {}
  const size = panelDefinition(type)?.defaultSize
  const at = placement.point
  const position = at && size ? originCentredOn(at, size) : undefined
  return { near: placement.canvasPanelId, ...(position ? { position } : {}) }
}
