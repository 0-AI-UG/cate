// The note panel type: a sticky note on a canvas, drawn without panel chrome
// (`frameless`). Its words are a record field (see contract.ts); there is no
// session state. Pure.

import { channel } from '@kernel/rpc/contract'
import { definePanel } from '@panels/framework/contract'
import type { JsonObject } from '@workspace/document/contract'
import { NOTE_TEXT_FIELD } from './contract'

export const noteDefinition = definePanel({
  type: 'note',
  label: 'Note',
  icon: 'sticky-note',
  defaultSize: { width: 320, height: 200 },
  minimumSize: { width: 160, height: 100 },
  canLiveOnCanvas: true,
  navigable: true,
  creation: { order: 4 },
  chrome: { frameless: true },
  defaultTitle: 'Note',
  fields: () => ({ [NOTE_TEXT_FIELD]: '' }),
  channel: channel<JsonObject, Partial<JsonObject>, never>(),
})

export default noteDefinition
