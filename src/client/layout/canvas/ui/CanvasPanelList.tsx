// A client without the `canvas` feature shows a canvas's panels as a list:
// rendering only, no op is sent (architecture 12.2).

import React from 'react'
import { clientStateFor } from '@client/document'
import { useDocument } from '@client/document/ui'
import { panelsOnCanvas, type WorkspaceDocument } from '@workspace/document/contract'
import { panelDefinition } from '../ports'
import { shallowArrayEqual } from './context'
import { canvasSlots } from './slots'

const LIST_ITEM_HEIGHT = 360

export function CanvasPanelList({ workspaceId, canvasId }: { workspaceId: string; canvasId: string }): React.ReactElement {
  const panelIds = useDocument(workspaceId, (d: WorkspaceDocument) => panelsOnCanvas(d, canvasId), shallowArrayEqual)
  const panels = useDocument(workspaceId, (d) => d.panels)
  const { PanelHost } = canvasSlots()
  if (panelIds.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-muted">This canvas is empty.</div>
  }
  return (
    <div data-canvas-list={canvasId} className="h-full overflow-y-auto">
      {panelIds.map((id) => {
        const record = panels[id]
        if (!record) return null
        return (
          <section key={id} data-canvas-list-item={id} className="border-b border-subtle">
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-sm text-primary hover:bg-hover"
              onClick={() => clientStateFor(workspaceId)?.focus(id)}
            >
              {record.title || panelDefinition(record.type)?.label || record.type}
            </button>
            {PanelHost && (
              <div style={{ height: LIST_ITEM_HEIGHT }}>
                <PanelHost workspaceId={workspaceId} panelId={id} />
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
