import React, { useState, useCallback } from 'react'
import { Plus } from '@phosphor-icons/react'
import { useAppStore, useWorkspaceList } from '../stores/appStore'
import { WorkspaceTab } from './WorkspaceTab'
import { SidebarSectionHeader, SidebarHeaderButton } from './SidebarSectionHeader'

export const ProjectList: React.FC = () => {
  const workspaces = useWorkspaceList()
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const addWorkspace = useAppStore((s) => s.addWorkspace)
  const selectWorkspace = useAppStore((s) => s.selectWorkspace)
  const removeWorkspace = useAppStore((s) => s.removeWorkspace)

  const handleNewWorkspace = useCallback(() => {
    // If there's already an uninitialized workspace (no folder picked yet),
    // reuse it instead of stacking another empty "Add Workspace" row.
    const existing = useAppStore.getState().workspaces.find((w) => !w.rootPath)
    const wsId = existing ? existing.id : addWorkspace()
    selectWorkspace(wsId)
  }, [addWorkspace, selectWorkspace])

  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const displayWorkspaces = workspaces

  return (
    <div className="flex flex-col h-full">
      <SidebarSectionHeader
        title="Workspace"
        actions={
          <SidebarHeaderButton onClick={handleNewWorkspace} title="New Workspace">
            <Plus size={14} weight="bold" />
          </SidebarHeaderButton>
        }
      />

      {/* Scrollable workspace list */}
      <div className="flex-1 overflow-y-auto px-1 py-1">
        <div className="flex flex-col">
          {displayWorkspaces.map((ws, index) => (
            <div
              key={ws.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', String(index))
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDragOverIndex(index)
              }}
              onDragLeave={() => setDragOverIndex(null)}
              onDrop={(e) => {
                e.preventDefault()
                const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10)
                if (!isNaN(fromIndex) && fromIndex !== index) {
                  useAppStore.getState().reorderWorkspaces(fromIndex, index)
                }
                setDragOverIndex(null)
              }}
              style={{
                borderTop: dragOverIndex === index ? '2px solid rgba(74, 158, 255, 0.6)' : '2px solid transparent',
                transition: 'border-color 0.15s',
              }}
            >
              <WorkspaceTab
                workspace={ws}
                isSelected={ws.id === selectedWorkspaceId}
                onClick={() => selectWorkspace(ws.id)}
                onClose={() => removeWorkspace(ws.id)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
