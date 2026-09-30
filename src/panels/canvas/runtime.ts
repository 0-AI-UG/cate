// What the daemon's composition root needs to register the canvas type.

import canvasDefinition from './definition'
import { CanvasSession } from './session'

export { canvasDefinition, CanvasSession }

export function canvasPanel() {
  return { definition: canvasDefinition, session: CanvasSession }
}
