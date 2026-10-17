// Answers client/host's "pick a spot or an existing panel" on a canvas with
// the canvas's own targeting overlay. A new panel alone is placed the way
// `placeOnCanvas` places it: at the next free spot when the placement picker
// setting is off.

import { installCanvasTargetPicker as installPicker, type CanvasTargetChoice } from '@client/host'
import { canvasViewFor } from './registry'
import { panelDefaultSize } from './ports'
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
      if (request.availability === 'new' && !canvasSetting('placementPicker')) {
        const size = panelDefaultSize(request.panelType)
        return Promise.resolve({ kind: 'new', point: store.getState().placeTarget(size).rect.origin, size })
      }
      return new Promise<CanvasTargetChoice | null>((resolve) => {
        const began = store.getState().beginPanelTarget({
          panelType: request.panelType,
          availability: request.availability,
          existing: request.existing,
          onSelected: (choice) => resolve(choice),
          onCancelled: () => resolve(null),
        })
        if (!began) resolve(null)
      })
    },
  })
}
