// The sidebar's workspace list from client/workspaces: local recents and
// paired workspaces in sidebar order. Click selects (and opens), Cmd/Ctrl and
// Shift build a multi-selection that Delete closes, rows drag to reorder, and
// the header expands every tree, opens a folder or joins a workspace.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronsDown as CaretDoubleDown, ChevronsUp as CaretDoubleUp, FolderPlus, Link2 } from 'lucide-react'
import { SidebarHeaderButton, SidebarSectionHeader, btn } from '../../kernel/interaction'
import { useWorkspaceList } from '../../client/workspaces'
import { clientApp } from '../app'
import { useDesktopPort } from '../desktop'
import { closeWorkspace, pickAndOpenFolder, selectWorkspace } from '../navigation'
import { useUIStore } from '../state/uiStore'
import { showMenu } from './menu'
import { WorkspaceRow } from './WorkspaceRow'

/** The ids in their new order after moving `from` to insertion slot `to`
 *  (0..n, n is after the last). */
export function moveId(ids: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= ids.length) return [...ids]
  const next = [...ids]
  const [moved] = next.splice(from, 1)
  next.splice(to > from ? to - 1 : to, 0, moved)
  return next
}

interface WorkspaceListProps {
  headerTitle?: React.ReactNode
  headerLeadingAction?: React.ReactNode
}

export function WorkspaceList({ headerTitle = 'Workspaces', headerLeadingAction }: WorkspaceListProps): JSX.Element {
  const list = clientApp().workspaces
  const { entries, open } = useWorkspaceList(list)
  const selectedId = useUIStore((s) => s.selectedWorkspaceId)
  const desktop = useDesktopPort()
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [insertIndex, setInsertIndex] = useState<number | null>(null)
  const anchorRef = useRef<number | null>(null)

  useEffect(() => {
    setMultiSelected((prev) => {
      const ids = new Set(entries.map((e) => e.id))
      const kept = new Set([...prev].filter((id) => ids.has(id)))
      return kept.size === prev.size ? prev : kept
    })
  }, [entries])

  const handleClick = useCallback((index: number, id: string, e?: React.MouseEvent) => {
    if (e?.shiftKey && anchorRef.current !== null) {
      const start = Math.min(anchorRef.current, index)
      const end = Math.max(anchorRef.current, index)
      setMultiSelected(new Set(entries.slice(start, end + 1).map((w) => w.id)))
      return
    }
    if (e?.metaKey || e?.ctrlKey) {
      setMultiSelected((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      anchorRef.current = index
      return
    }
    setMultiSelected(new Set())
    anchorRef.current = index
    useUIStore.getState().closeOverlay()
    void selectWorkspace(id)
  }, [entries])

  const closeSelected = useCallback(() => {
    for (const id of multiSelected) closeWorkspace(id)
    setMultiSelected(new Set())
    anchorRef.current = null
  }, [multiSelected])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && multiSelected.size > 0) {
      e.preventDefault()
      closeSelected()
    }
    if (e.key === 'Escape' && multiSelected.size > 0) {
      e.preventDefault()
      setMultiSelected(new Set())
    }
  }

  const handleBulkContextMenu = async (e: React.MouseEvent, id: string): Promise<boolean> => {
    if (multiSelected.size < 2 || !multiSelected.has(id)) return false
    e.preventDefault()
    e.stopPropagation()
    const choice = await showMenu([{ id: 'close-selected', label: `Close ${multiSelected.size} Workspaces` }])
    if (choice === 'close-selected') closeSelected()
    return true
  }

  const allExpanded = entries.length > 0 && entries.every((w) => expanded.has(w.id))
  const toggleExpanded = (id: string) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const slotFor = (e: React.DragEvent, index: number): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    return e.clientY > rect.top + rect.height / 2 ? index + 1 : index
  }

  return (
    <div className="flex flex-col h-full" tabIndex={-1} data-sidebar-keynav onKeyDown={handleKeyDown}>
      <SidebarSectionHeader
        title={headerTitle}
        large
        leadingAction={headerLeadingAction}
        actions={
          <>
            <SidebarHeaderButton
              onClick={() => setExpanded(allExpanded ? new Set() : new Set(entries.map((w) => w.id)))}
              title={allExpanded ? 'Collapse All' : 'Expand All'}
              disabled={entries.length === 0}
            >
              {allExpanded ? <CaretDoubleUp size={14} /> : <CaretDoubleDown size={14} />}
            </SidebarHeaderButton>
            <SidebarHeaderButton onClick={() => useUIStore.getState().setJoinDialogOpen(true)} title="Join a Workspace">
              <Link2 size={14} />
            </SidebarHeaderButton>
            {desktop && (
              <SidebarHeaderButton action="openFolder" onClick={() => void pickAndOpenFolder()} title="Open Folder">
                <FolderPlus size={14} />
              </SidebarHeaderButton>
            )}
          </>
        }
      />
      <div className="flex-1 overflow-y-auto pb-1" role="tree" aria-label="Workspaces">
        {entries.map((entry, index) => {
          const isLast = index === entries.length - 1
          return (
            <div
              key={entry.id}
              className="relative"
              draggable={multiSelected.size === 0}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', String(index))
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setInsertIndex(slotFor(e, index))
              }}
              onDrop={(e) => {
                e.preventDefault()
                const from = parseInt(e.dataTransfer.getData('text/plain'), 10)
                const to = slotFor(e, index)
                setInsertIndex(null)
                if (!isNaN(from)) void list.reorder(moveId(entries.map((w) => w.id), from, to))
              }}
              onDragEnd={() => setInsertIndex(null)}
            >
              {insertIndex === index && <div className="absolute left-0 right-0 top-0 h-0.5 bg-blue-400/60 z-10 pointer-events-none" />}
              {isLast && insertIndex === index + 1 && <div className="absolute left-0 right-0 bottom-0 h-0.5 bg-blue-400/60 z-10 pointer-events-none" />}
              <WorkspaceRow
                entry={entry}
                isOpen={open.includes(entry.id)}
                isSelected={entry.id === selectedId}
                isMultiSelected={multiSelected.has(entry.id)}
                isExpanded={expanded.has(entry.id)}
                onToggleExpand={() => toggleExpanded(entry.id)}
                onClick={(e) => handleClick(index, entry.id, e)}
                onBulkContextMenu={(e) => handleBulkContextMenu(e, entry.id)}
              />
            </div>
          )
        })}
        {entries.length === 0 && (
          <div data-sidebar-empty className="px-3 py-3 flex flex-col gap-1.5">
            {desktop && (
              <button type="button" className={`${btn.secondary} justify-center`} onClick={() => void pickAndOpenFolder()}>
                <FolderPlus size={14} />
                Open Workspace…
              </button>
            )}
            <button type="button" className={`${btn.ghost} justify-center`} onClick={() => useUIStore.getState().setJoinDialogOpen(true)}>
              <Link2 size={14} />
              Join a Workspace
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
