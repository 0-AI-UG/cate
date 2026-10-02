// The canvas panel type: a dock tab that shows one canvas of the document.
// The canvas itself (nodes, rects, mini docks) is document data; the panel
// has no session state. Pure.

import { channel } from '@kernel/rpc/contract'
import { storedShortcut } from '@kernel/ui/contract'
import { definePanel, type PanelCreateOptions } from '@panels/framework/contract'
import type { JsonObject } from '@workspace/document/contract'

export const canvasDefinition = definePanel({
  type: 'canvas',
  label: 'Canvas',
  icon: 'grid',
  defaultSize: { width: 800, height: 600 },
  minimumSize: { width: 400, height: 300 },
  dropSize: { width: 640, height: 480 },
  // A canvas lives only in docks; the reducer refuses canvas-on-canvas too.
  canLiveOnCanvas: false,
  navigable: false,
  creation: { order: 3, key: storedShortcut('c', { command: true, shift: true }) },
  requires: ['canvas'],
  defaultTitle: 'Canvas',
  channel: channel<JsonObject, Partial<JsonObject>, never>(),
  relation: {
    instruction: (kind) => `${kind === 'verify' ? 'Verify using its panels' : kind === 'use' ? 'Work through its panels' : 'Reference its panels'} when relevant.`,
  },
  // The record names a new canvas; `addPanel` creates the canvas with it.
  create: (options: PanelCreateOptions, kit) => kit.add(
    kit.record('canvas', { id: kit.newId(), title: options.title, canvasId: kit.newId() }),
    options,
  ),
})

export default canvasDefinition
