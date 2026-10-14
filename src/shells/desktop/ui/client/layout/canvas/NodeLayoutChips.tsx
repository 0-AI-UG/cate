// The layout switcher of a canvas node, in the node's top strip: one chip per
// layout. Click shows that layout (this client only); double-click or the
// menu renames it; the menu also closes it or moves it to another host (the
// main window or a new window). The + adds an empty layout.

import React, { useEffect, useRef, useState } from 'react'
import { PanelsTopLeft, Plus } from 'lucide-react'
import type { DockLayout, LayoutId, NodeId } from '@workspace/document/contract'
import { clientUi } from '@kernel/interaction'
import type { ContextMenuItem } from '@kernel/interaction/contract'
import { documentStoreFor } from '@client/document'
import { addLayout, renameLayout, switchLayout } from '@client/host'
import { closeLayout } from '../windows/closeLayout'
import { layoutMoveItems, runLayoutMove } from '../windows/layoutMenu'

export function NodeLayoutChips({ workspaceId, canvasId, nodeId, layouts, activeLayoutId }: {
  workspaceId: string
  canvasId: string
  nodeId: NodeId
  layouts: readonly DockLayout[]
  activeLayoutId: LayoutId
}) {
  const host = { canvasId, nodeId }
  const [renameId, setRenameId] = useState<LayoutId | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (renameId) { inputRef.current?.focus(); inputRef.current?.select() }
  }, [renameId])

  const label = (layout: DockLayout, index: number) => layout.name || `Layout ${index + 1}`
  const beginRename = (layout: DockLayout, index: number) => { setRenameValue(label(layout, index)); setRenameId(layout.id) }
  const commitRename = (layoutId: LayoutId) => {
    const value = renameValue.trim()
    if (value) renameLayout(workspaceId, layoutId, value)
    setRenameId(null)
  }

  const onContextMenu = async (e: React.MouseEvent, layout: DockLayout, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    const doc = documentStoreFor(workspaceId)?.getSnapshot()
    const moves = doc ? layoutMoveItems(doc, layout.id) : []
    const items: ContextMenuItem[] = [
      { id: 'rename', label: 'Rename' },
      ...(moves.length > 0 ? [{ type: 'separator' as const }, ...moves] : []),
      { type: 'separator' },
      { id: 'close', label: 'Close Layout', enabled: layouts.length > 1 },
    ]
    const ui = clientUi()
    const id = ui.showContextMenu ? await ui.showContextMenu(items) : null
    if (id === 'rename') beginRename(layout, index)
    else if (id === 'close') void closeLayout(workspaceId, layout.id)
    else if (id) runLayoutMove(workspaceId, layout.id, id)
  }

  return (
    <div data-node-layout-chips className="flex items-center gap-0.5 min-w-0 pl-1" onMouseDown={(e) => e.stopPropagation()}>
      {layouts.map((layout, index) => {
        const active = layout.id === activeLayoutId
        return (
          <div
            key={layout.id}
            data-layout-id={layout.id}
            data-active={active || undefined}
            title={label(layout, index)}
            className={`flex items-center gap-1 h-[18px] px-1.5 max-w-[140px] rounded-md text-[11px] cursor-pointer select-none ${
              active ? 'bg-surface-2 text-primary' : 'text-muted hover:text-secondary hover:bg-hover'}`}
            onClick={(e) => { e.stopPropagation(); switchLayout(workspaceId, host, layout.id) }}
            onDoubleClick={(e) => { e.stopPropagation(); beginRename(layout, index) }}
            onContextMenu={(e) => { void onContextMenu(e, layout, index) }}
          >
            <PanelsTopLeft size={11} className="shrink-0" />
            {renameId === layout.id ? (
              <input
                ref={inputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => commitRename(layout.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(layout.id) }
                  else if (e.key === 'Escape') { e.preventDefault(); setRenameId(null) }
                  e.stopPropagation()
                }}
                onClick={(e) => e.stopPropagation()}
                className="min-w-0 w-20 bg-transparent outline-none border-b border-focus text-primary"
                style={{ font: 'inherit' }}
              />
            ) : (
              <span className="truncate">{label(layout, index)}</span>
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
