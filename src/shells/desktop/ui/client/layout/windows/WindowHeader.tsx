// The header of a window: one chip per layout, drawn like the panel chips of a
// tab bar (icon, title or rename input, close button). Clicking a chip shows
// that layout; right-click renames or closes it (the + adds one). It switches what this client
// shows of the window, never a panel.

import React, { useEffect, useRef, useState } from 'react'
import { PanelsTopLeft, Plus, X } from 'lucide-react'
import type { DocWindow, LayoutId } from '@workspace/document/contract'
import { clientUi } from '@kernel/interaction'
import type { ContextMenuItem } from '@kernel/interaction/contract'
import { addLayout, renameLayout, switchLayout } from '@client/host'
import { Tooltip } from '../../../kernel/interaction'
import { isMiddleClick } from '../drag/dom'
import { closeLayout } from './closeLayout'

/** What a layout's chip shows: its name, else its position. */
export function layoutLabel(window: DocWindow, index: number): string {
  return window.layouts[index].name || `Layout ${index + 1}`
}

function showMenu(items: ContextMenuItem[]): Promise<string | null> {
  const ui = clientUi()
  return ui.showContextMenu ? ui.showContextMenu(items) : Promise.resolve(null)
}

export function WindowHeader({ workspaceId, window, activeLayoutId, leadingInset }: {
  workspaceId: string
  window: DocWindow
  activeLayoutId: LayoutId
  /** Space the chips leave at the left for window chrome (traffic lights). */
  leadingInset?: number
}) {
  const [renameId, setRenameId] = useState<LayoutId | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const seedRef = useRef('')
  const windowId = window.id
  const closable = window.layouts.length > 1

  useEffect(() => {
    if (renameId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [renameId])

  const beginRename = (layoutId: LayoutId) => {
    const index = window.layouts.findIndex((l) => l.id === layoutId)
    const label = index >= 0 ? layoutLabel(window, index) : ''
    seedRef.current = label
    setRenameValue(label)
    setRenameId(layoutId)
  }
  const commitRename = (layoutId: LayoutId) => {
    const trimmed = renameValue.trim()
    // The default label is not a name: committing it unchanged keeps the layout unnamed.
    if (trimmed && trimmed !== seedRef.current) renameLayout(workspaceId, windowId, layoutId, trimmed)
    setRenameId(null)
  }

  const onContextMenu = async (e: React.MouseEvent, layoutId: LayoutId) => {
    e.preventDefault()
    e.stopPropagation()
    const id = await showMenu([
      { id: 'rename', label: 'Rename' },
      { type: 'separator' },
      { id: 'close', label: 'Close Layout', enabled: closable },
    ])
    if (id === 'rename') beginRename(layoutId)
    else if (id === 'close') void closeLayout(workspaceId, windowId, layoutId)
  }

  return (
    <div
      data-window-header={windowId}
      className="app-header-bar flex-shrink-0 gap-1 border-b border-subtle select-none"
      // The solid band a window's tab bar had before the compact header.
      style={{
        backgroundColor: 'var(--node-chrome-bg, var(--surface-1))',
        ...(leadingInset ? { paddingLeft: leadingInset } : null),
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      {window.layouts.map((layout, index) => {
        const active = layout.id === activeLayoutId
        const label = layoutLabel(window, index)
        return (
          <div
            key={layout.id}
            data-layout-id={layout.id}
            data-active={active || undefined}
            title={label}
            className={`group relative flex items-center gap-1.5 whitespace-nowrap cursor-pointer select-none min-w-0 shrink rounded-[var(--node-tab-radius,10px)] transition-colors h-6 max-w-[200px] pl-2.5 text-[12px] ${
              closable ? 'pr-1' : 'pr-2.5'} ${active ? 'bg-surface-2 text-primary' : 'text-muted hover:text-secondary hover:bg-hover'}`}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onClick={() => switchLayout(workspaceId, windowId, layout.id)}
            onMouseDown={(e) => { if (isMiddleClick(e)) e.preventDefault() }}
            onAuxClick={(e) => {
              if (isMiddleClick(e) && closable) {
                e.preventDefault()
                e.stopPropagation()
                void closeLayout(workspaceId, windowId, layout.id)
              }
            }}
            onContextMenu={(e) => { void onContextMenu(e, layout.id) }}
          >
            <span className={`shrink-0 ${active ? 'text-secondary' : 'text-muted'}`}>
              <PanelsTopLeft size={13} />
            </span>
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
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                className="truncate flex-1 min-w-0 bg-transparent outline-none border-b border-focus text-primary px-0"
                style={{ font: 'inherit' }}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{label}</span>
            )}
            {closable && (
              <Tooltip label="Close layout">
                <span
                  role="button"
                  aria-label="Close layout"
                  className={`shrink-0 p-0.5 rounded-md text-muted hover:text-red-400 hover:bg-hover cursor-pointer transition-opacity ${
                    active ? 'opacity-70' : 'opacity-0 group-hover:opacity-100'}`}
                  onClick={(e) => { e.stopPropagation(); void closeLayout(workspaceId, windowId, layout.id) }}
                >
                  <X size={11} />
                </span>
              </Tooltip>
            )}
          </div>
        )
      })}
      <Tooltip label="New layout" action="newLayout">
        <button
          type="button"
          aria-label="New layout"
          className="flex items-center justify-center self-center w-6 h-6 rounded-[10px] text-muted hover:text-primary hover:bg-hover cursor-pointer focus:outline-none"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={() => addLayout(workspaceId, windowId)}
        >
          <Plus size={14} />
        </button>
      </Tooltip>
    </div>
  )
}
