// The sidebar's workspace list from client/workspaces, under the machine
// each workspace lives on, in sidebar order within each. Click selects (and
// opens), Cmd/Ctrl and Shift build a multi-selection that Delete closes, rows
// drag to reorder, and "+" (or, with no workspaces, a button) opens the Open
// picker.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, Monitor, Plus, Server, Link2 } from 'lucide-react'
import { Button, SidebarHeaderButton, SidebarSectionHeader } from '../../kernel/interaction'
import { groupByMachine, type MachineGroup } from '@client/workspaces'
import { useWorkspaceList } from '../../client/workspaces'
import { clientApp } from '../app'
import { closeWorkspaces, selectWorkspace } from '../navigation'
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
  const { entries: listed, open } = useWorkspaceList(list)
  const groups = useMemo(() => groupByMachine(listed), [listed])
  // Row order as shown: machine by machine.
  const entries = useMemo(() => groups.flatMap((g) => g.entries), [groups])
  const selectedId = useUIStore((s) => s.selectedWorkspaceId)
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [insertIndex, setInsertIndex] = useState<number | null>(null)
  const anchorRef = useRef<number | null>(null)
  /** The machine of the row being dragged: rows move within their machine. */
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
        actions={
          <SidebarHeaderButton action="openWorkspace" onClick={() => useUIStore.getState().setOpenDialogOpen(true)} title="Open Workspace…">
            <Plus size={14} />
          </SidebarHeaderButton>
        }
      />
      <div className="flex-1 overflow-y-auto pb-1" role="tree" aria-label="Workspaces">
        {groups.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
            <p className="text-xs text-muted">No workspaces yet</p>
            <Button onClick={() => useUIStore.getState().setOpenDialogOpen(true)}>
              <FolderOpen size={13} />
              Open a workspace
            </Button>
          </div>
        )}
        {groups.map((group) => (
          <React.Fragment key={group.machine.key}>
            <MachineHeader group={group} />
            {group.entries.map((entry) => {
              const index = entries.indexOf(entry)
              const isLast = entry === group.entries[group.entries.length - 1]
              return (
                <div
                  key={entry.id}
                  className="relative"
                  draggable={multiSelected.size === 0}
                  onDragStart={(e) => {
                    draggingFrom.current = group.machine.key
                    e.dataTransfer.setData('text/plain', String(index))
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(e) => {
                    // No drop on another machine's rows.
                    if (draggingFrom.current !== group.machine.key) return setInsertIndex(null)
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
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

/** A machine's header: its icon and name, grouping its workspaces. */
function MachineHeader({ group }: { group: MachineGroup }): JSX.Element {
  const { machine } = group
  const label = machine.kind === 'this' ? 'This device' : machine.label ?? 'Paired'
  const Icon = machine.kind === 'this' ? Monitor : machine.kind === 'machine' ? Server : Link2
  return (
    <div
      data-machine={machine.key}
      className="mx-1.5 mt-2 mb-0.5 flex h-6 items-center gap-1.5 px-1.5 text-[11px] font-medium text-muted"
    >
      <Icon size={11} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </div>
  )
}
