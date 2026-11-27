// The text panel type: free text on a canvas, a heading or a label between
// panels, drawn without panel chrome (`frameless`) in a box that is moved and
// resized like any node and grows down when the words need more room. Its
// words and look are record fields (`./contract`, the words shared with the
// note's `panels/note/contract`); there is no session state. Pure.

import { channel } from '@kernel/rpc/contract'
import { definePanel } from '@panels/framework/contract'
import type { JsonObject } from '@workspace/document/contract'
import { NOTE_TEXT_FIELD } from '@panels/note/contract'
import { DEFAULT_TEXT_STYLE, TEXT_COLOR_FIELD, TEXT_FAMILY_FIELD, TEXT_SIZE_FIELD, TEXT_WEIGHT_FIELD } from './contract'

export const textDefinition = definePanel({
  type: 'text',
  label: 'Text',
  icon: 'type',
  defaultSize: { width: 320, height: 160 },
  minimumSize: { width: 40, height: 32 },
  canLiveOnCanvas: true,
  navigable: false,
  creation: { order: 5, toolbar: true },
  chrome: { frameless: true },
  defaultTitle: 'Text',
  fields: () => ({
    [NOTE_TEXT_FIELD]: '',
    [TEXT_COLOR_FIELD]: DEFAULT_TEXT_STYLE.color,
    [TEXT_SIZE_FIELD]: DEFAULT_TEXT_STYLE.size,
    [TEXT_WEIGHT_FIELD]: DEFAULT_TEXT_STYLE.weight,
    [TEXT_FAMILY_FIELD]: DEFAULT_TEXT_STYLE.family,
  }),
  channel: channel<JsonObject, Partial<JsonObject>, never>(),
})

export default textDefinition
