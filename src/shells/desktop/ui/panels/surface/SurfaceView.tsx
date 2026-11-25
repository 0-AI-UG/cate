import React from 'react'
import type { PanelViewProps } from '../../client/host/views'
import { documentStoreFor } from '@client/document'
import { useDocument } from '../../client/document'
import { SurfaceChoiceList } from '../../client/layout/dock/SurfaceChoiceList'
import type { PanelType } from '@workspace/document/contract'
import { surfaceChoices, surfaceReplacement } from '@panels/definitions'

export default function SurfaceView({ workspaceId, panelId, record }: PanelViewProps) {
  const choices = useDocument(workspaceId, (doc) => surfaceChoices(doc, panelId),
    (a, b) => a.length === b.length && a.every((item, index) => item === b[index]))
  const choose = (type: PanelType) => {
    const store = documentStoreFor(workspaceId)
    const replacement = store && surfaceReplacement(store.getSnapshot(), record.id, type)
    if (replacement) store.propose({ kind: 'replacePanel', record: replacement })
  }
  return <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-surface-0 p-4">
    <div className="m-auto w-full max-w-xs py-4">
      <SurfaceChoiceList choices={choices} onPick={(type) => choose(type as PanelType)} />
    </div>
  </div>
}
