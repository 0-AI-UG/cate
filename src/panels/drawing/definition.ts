// The drawing panel type: the strokes of one drawing session on a canvas,
// drawn without panel chrome (`frameless`) in a node that is moved and
// resized (which scales the drawing) like any other. Only the canvas's draw
// tool creates it, so it is in no creation menu. Its strokes are record
// fields (see contract.ts); there is no session state. Pure.

import { channel } from '@kernel/rpc/contract'
import { definePanel } from '@panels/framework/contract'
import type { Json, JsonObject } from '@workspace/document/contract'
import { DRAWING_FRAME_FIELD, DRAWING_STROKES_FIELD } from './contract'

/** What the draw tool creates a drawing with: its first stroke and space. */
export interface DrawingCreateOptions {
  strokes?: Json
  frame?: Json
}

export const drawingDefinition = definePanel({
  type: 'drawing',
  label: 'Drawing',
  icon: 'pencil',
  defaultSize: { width: 200, height: 200 },
  minimumSize: { width: 8, height: 8 },
  canLiveOnCanvas: true,
  navigable: false,
  chrome: { frameless: true },
  defaultTitle: 'Drawing',
  fields: (options: DrawingCreateOptions) => ({
    [DRAWING_STROKES_FIELD]: Array.isArray(options.strokes) ? options.strokes : [],
    ...(options.frame ? { [DRAWING_FRAME_FIELD]: options.frame } : {}),
  }),
  channel: channel<JsonObject, Partial<JsonObject>, never>(),
})

export default drawingDefinition
