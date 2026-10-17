// The surface panel type: a placeholder that becomes the panel type the user
// picks, in place (`replacePanel`). Pure.

import { channel } from '@kernel/rpc/contract'
import { definePanel } from '@panels/framework/contract'
import type { JsonObject } from '@workspace/document/contract'

export const surfaceDefinition = definePanel({
  type: 'surface',
  label: 'Open a surface',
  icon: 'plus',
  defaultSize: { width: 540, height: 500 },
  minimumSize: { width: 220, height: 200 },
  dropSize: { width: 540, height: 500 },
  canLiveOnCanvas: true,
  navigable: false,
  placeholder: true,
  defaultTitle: 'Open a surface',
  channel: channel<JsonObject, Partial<JsonObject>, never>(),
})

export default surfaceDefinition
