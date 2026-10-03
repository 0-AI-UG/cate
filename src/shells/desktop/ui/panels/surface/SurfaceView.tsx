import React from 'react'
import type { PanelViewProps } from '../../client/host/views'
import { documentStoreFor } from '@client/document'
import { useDocument } from '../../client/document'
import { Icon } from '../../kernel/interaction'
import { isIconName } from '@kernel/interaction/contract'
import type { PanelType } from '@workspace/document/contract'
import { pickSurface, surfaceChoices } from './parts/pickSurface'

export default function SurfaceView({ workspaceId, panelId, record }: PanelViewProps) {
  const choices = useDocument(workspaceId, (doc) => surfaceChoices(doc, panelId),
    (a, b) => a.length === b.length && a.every((item, index) => item === b[index]))
  const choose = (type: PanelType) => {
    const store = documentStoreFor(workspaceId)
    if (store) pickSurface(store, record, type)
  }
  return <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
    <div className="m-auto w-full max-w-lg py-4">
      <div role="group" aria-label="Open a surface" className="flex flex-col gap-1">
        {choices.map((definition) => (
          <button type="button" key={definition.type} onClick={() => choose(definition.type)} className="flex min-h-10 items-center rounded-lg bg-surface-1 px-3 py-2 text-left text-primary hover:bg-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            <span className="flex items-center gap-3 text-[13px]">
              {isIconName(definition.icon) && <Icon name={definition.icon} size={16} className="shrink-0 text-muted" />}
              {definition.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  </div>
}
