// The header of a window: one chip per layout, drawn like the panel chips of a
// tab bar (icon, title or rename input, close button). Clicking a chip shows
// that layout; dragging a chip along the header reorders it; right-click
// renames or closes it (the + adds one). A panel
// dragged onto the header makes a new layout; a chip of another layout takes it
// into that layout. It switches what this client
// shows of the window, never a panel.

import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PanelsTopLeft, Plus, X } from 'lucide-react'
import { layoutOf, type DocWindow, type LayoutId } from '@workspace/document/contract'
import { documentStoreFor } from '@client/document'
import { clientUi } from '@kernel/interaction'
import type { ContextMenuItem } from '@kernel/interaction/contract'
import { addLayout, moveLayout, renameLayout, switchLayout } from '@client/host'
import { Tooltip } from '../../../kernel/interaction'
import { DropGhostChip } from '../dock'
import { isMiddleClick } from '../drag/dom'
import { registerDropZone } from '../drag/registry'
import { useDragStore } from '../drag/store'
import { closeLayout } from './closeLayout'

/** What a layout's chip shows: its name, else its position. */
export function layoutLabel(window: DocWindow, index: number): string {
  return window.layouts[index].name || `Layout ${index + 1}`
}

/** Pointer travel before a press on a chip becomes a reorder. */
const REORDER_THRESHOLD_PX = 4

/** How long a dragged panel hovers a layout chip before the layout shows (a tab's is 600). */
const SPRING_LOAD_MS = 600

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
  const headerRef = useRef<HTMLDivElement | null>(null)
  const chipRefs = useRef(new Map<LayoutId, HTMLDivElement>())
  // A dragged panel dropped on the header (outside any chip) becomes a new layout.
  const dragging = useDragStore((s) => s.isDragging)
  const target = useDragStore((s) => s.target)
  const newLayoutHover = dragging && target?.kind === 'layout-new' && target.workspaceId === workspaceId && target.windowId === window.id
  // The layout a dragged panel would join: solid accent (the dashed ghost means "new").
  const joinLayoutId = dragging && target?.kind === 'dock-zone' && !target.edge && target.workspaceId === workspaceId
    && 'layoutId' in target.dock && target.dock.windowId === window.id ? target.dock.layoutId : null
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A dragged panel can be dropped on a layout's chip: it goes to that
  // layout's first stack (the whole-dock drop). A panel already in the layout
  // gets nothing there: the chip claims the cursor, so the header's new-layout
  // drop (and its ghost) stays away.
  const layoutKey = window.layouts.map((l) => l.id).join('\0')
  useEffect(() => {
    const stops = layoutKey.split('\0').map((layoutId) => registerDropZone({
      id: `layout-chip-${workspaceId}-${windowId}-${layoutId}`,
      layoutChip: true,
      workspaceId,
      dock: { windowId, layoutId },
      getRect: () => chipRefs.current.get(layoutId)?.getBoundingClientRect() ?? null,
      getElement: () => chipRefs.current.get(layoutId) ?? null,
      noopFor: (source) => {
        const doc = documentStoreFor(workspaceId)?.getSnapshot()
        const own = doc ? layoutOf(doc, source.panelId) : null
        return own?.windowId === windowId && own.layoutId === layoutId
      },
    }))
    return () => { for (const stop of stops) stop() }
  }, [workspaceId, windowId, layoutKey])
  useEffect(() => registerDropZone({
    id: `layout-new-${workspaceId}-${windowId}`,
    workspaceId,
    dock: { windowId, layoutId: '' },
    newLayout: true,
    getRect: () => headerRef.current?.getBoundingClientRect() ?? null,
    getElement: () => headerRef.current,
  }), [workspaceId, windowId])
  // Reordering: pressing a chip and moving along the header lifts it. Like a
  // dragged tab, its chip leaves the row for a dashed ghost at the slot it
  // would take, and a copy follows the cursor. Only this header listens: panel
  // drags and layout drags never meet. `slot` is the index among the others;
  // it is measured against the chips as they stood at the press, so the ghost
  // opening a gap cannot move the targets.
  const [reorder, setReorder] = useState<{ layoutId: LayoutId; slot: number; left: number; top: number; width: number } | null>(null)
  const justReordered = useRef(false)
  const startReorder = (e: React.PointerEvent, layoutId: LayoutId) => {
    if (e.button !== 0 || renameId || window.layouts.length < 2) return
    const startX = e.clientX
    const own = chipRefs.current.get(layoutId)?.getBoundingClientRect()
    if (!own) return
    const mids = window.layouts
      .filter((l) => l.id !== layoutId)
      .map((l) => { const r = chipRefs.current.get(l.id)?.getBoundingClientRect(); return r ? r.left + r.width / 2 : Infinity })
    let slot = -1
    const move = (ev: PointerEvent) => {
      if (slot < 0 && Math.abs(ev.clientX - startX) < REORDER_THRESHOLD_PX) return
      slot = mids.filter((mid) => ev.clientX > mid).length
      setReorder({ layoutId, slot, left: own.left + ev.clientX - startX, top: own.top, width: own.width })
    }
    const end = () => {
      globalThis.removeEventListener('pointermove', move)
      globalThis.removeEventListener('pointerup', end)
      globalThis.removeEventListener('pointercancel', end)
      setReorder(null)
      if (slot < 0) return
      justReordered.current = true // swallows the click that follows the release
      globalThis.setTimeout(() => { justReordered.current = false }, 0)
      if (window.layouts[slot]?.id !== layoutId) moveLayout(workspaceId, windowId, layoutId, slot)
    }
    globalThis.addEventListener('pointermove', move)
    globalThis.addEventListener('pointerup', end)
    globalThis.addEventListener('pointercancel', end)
  }
  const lifted = reorder ? window.layouts.findIndex((l) => l.id === reorder.layoutId) : -1
  const ghostBefore = reorder ? window.layouts.filter((l) => l.id !== reorder.layoutId)[reorder.slot]?.id : undefined
  const reorderGhost = lifted >= 0 ? (
    <DropGhostChip key="__layout-ghost__" data-reorder-ghost icon={<PanelsTopLeft size={13} />}>
      {layoutLabel(window, lifted)}
    </DropGhostChip>
  ) : null
  useEffect(() => () => { if (springTimer.current) globalThis.clearTimeout(springTimer.current) }, [])

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
      ref={headerRef}
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
        if (reorder?.layoutId === layout.id) return null
        const active = layout.id === activeLayoutId
        const label = layoutLabel(window, index)
        return (
          <React.Fragment key={layout.id}>
          {ghostBefore === layout.id && reorderGhost}
          <div
            ref={(el) => { if (el) chipRefs.current.set(layout.id, el); else chipRefs.current.delete(layout.id) }}
            data-layout-id={layout.id}
            data-active={active || undefined}
            title={label}
            className={`group relative flex items-center gap-1.5 whitespace-nowrap cursor-pointer select-none min-w-0 shrink rounded-[var(--node-tab-radius,10px)] transition-colors h-6 max-w-[200px] pl-2.5 text-[12px] ${
              closable ? 'pr-1' : 'pr-2.5'} ${active ? 'bg-surface-2 text-primary' : 'text-muted hover:text-secondary hover:bg-hover'}`}
            style={{
              WebkitAppRegion: 'no-drag',
              ...(joinLayoutId === layout.id ? {
                color: 'var(--focus-blue, #3b82f6)',
                backgroundColor: 'color-mix(in srgb, var(--focus-blue, #3b82f6) 18%, transparent)',
                boxShadow: 'inset 0 0 0 1.5px var(--focus-blue, #3b82f6)',
              } : null),
            } as React.CSSProperties}
            data-join-target={joinLayoutId === layout.id || undefined}
            onPointerDown={(e) => startReorder(e, layout.id)}
            onClick={() => { if (!justReordered.current) switchLayout(workspaceId, windowId, layout.id) }}
            onMouseDown={(e) => { if (isMiddleClick(e)) e.preventDefault() }}
            onAuxClick={(e) => {
              if (isMiddleClick(e) && closable) {
                e.preventDefault()
                e.stopPropagation()
                void closeLayout(workspaceId, windowId, layout.id)
              }
            }}
            onContextMenu={(e) => { void onContextMenu(e, layout.id) }}
            // Spring-load, like a tab: hovering another layout mid-drag shows it.
            onPointerEnter={() => {
              if (active || !useDragStore.getState().isDragging) return
              if (springTimer.current) globalThis.clearTimeout(springTimer.current)
              springTimer.current = globalThis.setTimeout(() => switchLayout(workspaceId, windowId, layout.id), SPRING_LOAD_MS)
            }}
            onPointerLeave={() => {
              if (springTimer.current) { globalThis.clearTimeout(springTimer.current); springTimer.current = null }
            }}
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
          </React.Fragment>
        )
      })}
      {reorderGhost && ghostBefore === undefined && reorderGhost}
      {reorder && lifted >= 0 && createPortal(
        // The chip under the cursor, drawn like the one lifted from the row.
        <div
          aria-hidden
          data-reorder-floating
          className="fixed z-[10000] pointer-events-none flex items-center gap-1.5 whitespace-nowrap h-6 pl-2.5 pr-2.5 text-[12px] rounded-[var(--node-tab-radius,10px)] bg-surface-2 text-primary shadow-lg"
          style={{ left: reorder.left, top: reorder.top, width: reorder.width }}
        >
          <span className="shrink-0 text-secondary"><PanelsTopLeft size={13} /></span>
          <span className="min-w-0 flex-1 truncate">{layoutLabel(window, lifted)}</span>
        </div>,
        document.body,
      )}
      {newLayoutHover && (
        <DropGhostChip data-new-layout-ghost icon={<PanelsTopLeft size={13} />}>new layout</DropGhostChip>
      )}
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
