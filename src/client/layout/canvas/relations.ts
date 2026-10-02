// Wires the relation UI (workspace/relations/ui) to this client: documents,
// settings, panel definitions and creation, and the tab menu's "Connect to…".
// The shell calls it once.

import { documentStoreFor, subscribeDocumentStores } from '@client/document'
import { registerTabMenuItems } from '@client/layout/dock'
import { connectPanelToExisting, installRelationUiHost } from '@workspace/relations/ui'
import { canvasHost } from './ports'
import { canvasSetting, setCanvasSetting, subscribeCanvasSettings, workspaceSettingsSource } from './settings'

export function installCanvasRelationHost(): () => void {
  installRelationUiHost({
    document: (workspaceId) => documentStoreFor(workspaceId),
    subscribeDocuments: subscribeDocumentStores,
    savedLabels: {
      get: () => canvasSetting('savedPanelRelationLabels'),
      set: (labels) => setCanvasSetting('savedPanelRelationLabels', labels),
      subscribe: subscribeCanvasSettings,
    },
    relationsEnabled: (workspaceId) => {
      const source = workspaceSettingsSource(workspaceId)
      return source ? { get: () => source.get('panelRelationsEnabled'), subscribe: (listener) => source.subscribe(listener) } : null
    },
    definitions: () => canvasHost().definitions(),
    creatable: () => canvasHost().creatable({ onCanvas: true }),
    createPanel: (workspaceId, type, options) => canvasHost().createPanel(workspaceId, type, options),
  })
  return registerTabMenuItems({
    items: ({ workspaceId }) => (workspaceSettingsSource(workspaceId)?.get('panelRelationsEnabled') ?? true)
      ? [{ id: 'connect', label: 'Connect to…' }]
      : [],
    run(id, { workspaceId, record }) {
      if (id !== 'connect') return false
      void connectPanelToExisting(workspaceId, record.id)
      return true
    },
  })
}
