// Answers client/host's "pick a spot or an existing panel" on a canvas with
// the canvas's own targeting overlay. A new panel alone is placed the way
// `placeOnCanvas` places it: at the next free spot when the placement picker
// setting is off.

import { installCanvasTargetPicker as installPicker, type CanvasTargetChoice } from '@client/host'
import { canvasViewFor } from './registry'
import { canvasSetting } from './settings'

let installed = false

/** Idempotent; the canvas view calls it when it first mounts. */
export function installCanvasTargetPicker(): void {
  if (installed) return
  installed = true
  installPicker({
    pick(request) {
      const store = canvasViewFor(request.workspaceId, request.canvasId)
      if (!store) return Promise.resolve(null)
      return new Promise<CanvasTargetChoice | null>((resolve) => {
        const began = store.getState().beginPanelTarget({
          panelType: request.panelType,
          availability: request.availability,
          existing: request.existing,
          pick: request.availability !== 'new' || canvasSetting('placementPicker'),
          onSelected: (choice) => resolve(choice),
          onCancelled: () => resolve(null),
        })
        if (!began) resolve(null)
      })
    },
  })
}
