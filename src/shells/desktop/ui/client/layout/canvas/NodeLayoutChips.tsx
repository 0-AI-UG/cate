// The layout switcher of a canvas node, in the node's top strip: one chip per
// layout. Click shows that layout (this client only); double-click or the
// menu renames it; the menu also closes it or moves it to another host (the
// main window or a new window). The + adds an empty layout.

import React from 'react'
import { PanelsTopLeft, Plus } from 'lucide-react'
import type { DockLayout, LayoutId, NodeId } from '@workspace/document/contract'
import { addLayout, switchLayout } from '@client/host'
import { showLayoutMenu } from '../windows/layoutMenu'
import { useLayoutRename } from '../windows/useLayoutRename'

export function NodeLayoutChips({ workspaceId, canvasId, nodeId, layouts, activeLayoutId }: {
  workspaceId: string
  canvasId: string
  nodeId: NodeId
  layouts: readonly DockLayout[]
  activeLayoutId: LayoutId
}) {
  const host = { canvasId, nodeId }
  const rename = useLayoutRename(workspaceId)

  return (
    <div data-node-layout-chips className="flex items-center gap-0.5 min-w-0 pl-1" onMouseDown={(e) => e.stopPropagation()}>
      {layouts.map((layout) => {
        const active = layout.id === activeLayoutId
        return (
          <div
            key={layout.id}
            data-layout-id={layout.id}
            data-active={active || undefined}
            title={layout.name}
            className={`flex items-center gap-1 h-[18px] px-1.5 max-w-[140px] rounded-md text-[11px] cursor-pointer select-none ${
              active ? 'bg-surface-2 text-primary' : 'text-muted hover:text-secondary hover:bg-hover'}`}
            onClick={(e) => { e.stopPropagation(); switchLayout(workspaceId, host, layout.id) }}
            onDoubleClick={(e) => { e.stopPropagation(); rename.begin(layout) }}
            onContextMenu={(e) => { void showLayoutMenu(e, workspaceId, layout.id, { onRename: () => rename.begin(layout), closable: layouts.length > 1 }) }}
          >
            <PanelsTopLeft size={11} className="shrink-0" />
            {rename.renameId === layout.id ? (
              rename.input(layout.id, 'min-w-0 w-20')
            ) : (
              <span className="truncate">{layout.name}</span>
            )}
          </div>
        )
      })}
      <button
        type="button"
        aria-label="New layout"
        className="flex items-center justify-center w-[18px] h-[18px] rounded-md text-muted hover:text-primary hover:bg-hover cursor-pointer focus:outline-none"
        onClick={(e) => { e.stopPropagation(); addLayout(workspaceId, host) }}
      >
        <Plus size={12} />
      </button>
    </div>
  )
}
