import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Plus } from '@phosphor-icons/react'
import { useAppStore, useWorkspaceList } from '../stores/appStore'
import { WorkspaceTab } from './WorkspaceTab'
import { SidebarSectionHeader, SidebarHeaderButton } from './SidebarSectionHeader'
import type { NativeContextMenuItem } from '../../shared/electron-api.d'

export const ProjectList: React.FC = () => {
  const workspaces = useWorkspaceList()
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const addWorkspace = useAppStore((s) => s.addWorkspace)
  const selectWorkspace = useAppStore((s) => s.selectWorkspace)
  const removeWorkspace = useAppStore((s) => s.removeWorkspace)

  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set())
  const lastClickedIndexRef = useRef<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Clear multi-selection when workspaces change (e.g. after deletion)
  useEffect(() => {
    setMultiSelected((prev) => {
      const wsIds = new Set(workspaces.map((w) => w.id))
      const filtered = new Set([...prev].filter((id) => wsIds.has(id)))
      if (filtered.size === prev.size) return prev
      return filtered
    })
  }, [workspaces])

  const handleWorkspaceClick = useCallback((index: number, wsId: string, e?: React.MouseEvent) => {
    // Shift-click — select the contiguous range from the anchor to here.
    if (e?.shiftKey && lastClickedIndexRef.current !== null) {
      const start = Math.min(lastClickedIndexRef.current, index)
      const end = Math.max(lastClickedIndexRef.current, index)
      const rangeIds = new Set<string>()
      for (let i = start; i <= end; i++) {
        rangeIds.add(workspaces[i].id)
      }
      setMultiSelected(rangeIds)
      return
    }

    // Cmd/Ctrl-click — toggle this workspace in/out of the multi-selection
    // (matches the file explorer's multi-select).
    if (e?.metaKey || e?.ctrlKey) {
      setMultiSelected((prev) => {
        const next = new Set(prev)
        if (next.has(wsId)) next.delete(wsId)
        else next.add(wsId)
        return next
      })
      lastClickedIndexRef.current = index
      return
    }

    setMultiSelected(new Set())
    lastClickedIndexRef.current = index
    selectWorkspace(wsId)
  }, [workspaces, selectWorkspace])

  const handleBulkDelete = useCallback(() => {
    if (multiSelected.size === 0) return
    const idsToRemove = [...multiSelected]
    setMultiSelected(new Set())
    lastClickedIndexRef.current = null
    for (const id of idsToRemove) {
      useAppStore.getState().removeWorkspace(id, true)
    }
  }, [multiSelected])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && multiSelected.size > 0) {
      e.preventDefault()
      handleBulkDelete()
    }
    if (e.key === 'Escape' && multiSelected.size > 0) {
      e.preventDefault()
      setMultiSelected(new Set())
    }
  }, [multiSelected, handleBulkDelete])

  const handleBulkContextMenu = useCallback(async (e: React.MouseEvent, wsId: string) => {
    if (multiSelected.size < 2) return false
    if (!multiSelected.has(wsId)) return false
    e.preventDefault()
    e.stopPropagation()
    if (!window.electronAPI) return true
    const items: NativeContextMenuItem[] = [
      { id: 'delete-selected', label: `Close ${multiSelected.size} Workspaces` },
    ]
    const id = await window.electronAPI.showContextMenu(items)
    if (id === 'delete-selected') {
      handleBulkDelete()
    }
    return true
  }, [multiSelected, handleBulkDelete])

  const handleNewWorkspace = useCallback(() => {
    const existing = useAppStore.getState().workspaces.find((w) => !w.rootPath)
    const wsId = existing ? existing.id : addWorkspace()
    selectWorkspace(wsId)
    setMultiSelected(new Set())
  }, [addWorkspace, selectWorkspace])

  // Insertion slot the drop would land in: 0..N where N is "after the last
  // row". Derived from which half of a row the cursor is over, so the bottom
  // slot (below the last workspace) is reachable.
  const [insertIndex, setInsertIndex] = useState<number | null>(null)

  const displayWorkspaces = workspaces

  return (
    <div
      className="flex flex-col h-full"
      ref={containerRef}
      tabIndex={-1}
      data-sidebar-keynav
      onKeyDown={handleKeyDown}
    >
      <SidebarSectionHeader
        title="Workspace"
        actions={
          <SidebarHeaderButton onClick={handleNewWorkspace} title="New Workspace">
            <Plus size={14} weight="bold" />
          </SidebarHeaderButton>
        }
      />

      {/* Scrollable workspace list. No top padding so the first row sits flush
          beneath the 36px header — matching the canvas dock tab bar, whose
          content starts flush below its bar. A top gap makes the header read
          as taller than the canvas header. */}
      <div className="flex-1 overflow-y-auto pb-1">
        <div className="flex flex-col">
          {displayWorkspaces.map((ws, index) => {
            const isLast = index === displayWorkspaces.length - 1
            return (
              <div
                key={ws.id}
                className="relative"
                draggable={multiSelected.size === 0}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', String(index))
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  // Top half → insert before this row; bottom half → after it.
                  // The bottom half of the last row targets the final slot.
                  const rect = e.currentTarget.getBoundingClientRect()
                  const after = e.clientY > rect.top + rect.height / 2
                  setInsertIndex(after ? index + 1 : index)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10)
                  // Recompute the target slot from the drop position rather than
                  // reading insertIndex state, which can be stale in this closure.
                  const rect = e.currentTarget.getBoundingClientRect()
                  const to = e.clientY > rect.top + rect.height / 2 ? index + 1 : index
                  setInsertIndex(null)
                  if (!isNaN(fromIndex)) {
                    useAppStore.getState().reorderWorkspaces(fromIndex, to)
                  }
                }}
                onDragEnd={() => setInsertIndex(null)}
              >
                {/* Drop indicators overlay the row edges so cards stay flush
                    (no reserved border space → no inter-card gap). */}
                {insertIndex === index && (
                  <div className="absolute left-0 right-0 top-0 h-0.5 bg-blue-400/60 z-10 pointer-events-none" />
                )}
                {isLast && insertIndex === index + 1 && (
                  <div className="absolute left-0 right-0 bottom-0 h-0.5 bg-blue-400/60 z-10 pointer-events-none" />
                )}
                <WorkspaceTab
                  workspace={ws}
                  isSelected={ws.id === selectedWorkspaceId}
                  isMultiSelected={multiSelected.has(ws.id)}
                  onClick={(e) => handleWorkspaceClick(index, ws.id, e)}
                  onClose={() => removeWorkspace(ws.id, true)}
                  onBulkContextMenu={(e) => handleBulkContextMenu(e, ws.id)}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
