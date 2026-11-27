// What the daemon's composition root needs to register the drawing type.

import drawingDefinition from './definition'
import { DrawingSession } from './session'

export { drawingDefinition, DrawingSession }

export function drawingPanel() {
  return { definition: drawingDefinition, session: DrawingSession }
}
