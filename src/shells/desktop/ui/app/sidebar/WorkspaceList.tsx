// The sidebar's flat, manually ordered workspace list from client/workspaces. Click selects (and
// opens), Cmd/Ctrl and Shift build a multi-selection that Delete closes, rows
// drag to reorder, and "+" (or, with no workspaces, a button) opens the Open
// picker.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { SidebarHeaderButton, SidebarSectionHeader } from '../../kernel/interaction'
import { useWorkspaceList } from '../../client/workspaces'
import { clientApp } from '../app'
import { closeWorkspaces, selectWorkspace } from '../navigation'
import { useUIStore } from '../state/uiStore'
import { OPEN_WORKSPACE_ANCHOR } from '../remote/OpenWorkspaceDialog'
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
  const pickerOpen = useUIStore((s) => s.openDialogOpen)
  const toggleOpenPicker = () => {
    const ui = useUIStore.getState()
    if (ui.openDialogOpen) ui.closeWorkspacePicker()
    else ui.openWorkspacePicker()
  }
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [insertIndex, setInsertIndex] = useState<number | null>(null)
  const anchorRef = useRef<number | null>(null)
  /** The workspace row being dragged. */
  const draggingFrom = useRef<string | null>(null)

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
    void closeWorkspaces([...multiSelected])
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
        // With none, the welcome page shows the picker itself.
        actions={entries.length > 0 && (
          <SidebarHeaderButton action="openWorkspace" onClick={toggleOpenPicker} title="Open Workspace…" aria-expanded={pickerOpen} {...{ [OPEN_WORKSPACE_ANCHOR]: '' }}>
            <Plus size={14} />
          </SidebarHeaderButton>
        )}
      />
      <div className="flex-1 overflow-y-auto pb-1" role="tree" aria-label="Workspaces">
        {entries.length === 0 && (
          <p className="px-4 py-8 text-center text-xs text-muted">No workspaces yet</p>
        )}
        {entries.map((entry, index) => {
          const isLast = entry === entries[entries.length - 1]
          return (
            <div
              key={entry.id}
              className="relative"
              draggable={multiSelected.size === 0}
              onDragStart={(e) => {
                draggingFrom.current = entry.id
                e.dataTransfer.setData('text/plain', String(index))
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                if (!draggingFrom.current) return
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
              onDragEnd={() => { draggingFrom.current = null; setInsertIndex(null) }}
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
      </div>
    </div>
  )
}
