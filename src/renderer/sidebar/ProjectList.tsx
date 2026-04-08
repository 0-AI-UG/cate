import React, { useState, useCallback } from 'react'
import { Plus } from '@phosphor-icons/react'
import { SidebarToggleIcon } from './SidebarToggleIcon'
import { useAppStore, useWorkspaceList } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { NotificationBell } from '../ui/NotificationPopover'
import { WorkspaceTab } from './WorkspaceTab'
import { SidebarSectionHeader, SidebarHeaderButton } from './SidebarSectionHeader'

interface ProjectListProps {
  onCollapse?: () => void
}

export const ProjectList: React.FC<ProjectListProps> = ({ onCollapse }) => {
  const workspaces = useWorkspaceList()
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const addWorkspace = useAppStore((s) => s.addWorkspace)
  const selectWorkspace = useAppStore((s) => s.selectWorkspace)
  const removeWorkspace = useAppStore((s) => s.removeWorkspace)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const handleCollapse = onCollapse ?? toggleSidebar

  const handleNewWorkspace = useCallback(() => {
    const wsId = addWorkspace()
    selectWorkspace(wsId)
  }, [addWorkspace, selectWorkspace])

  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const displayWorkspaces = workspaces

  return (
    <div className="flex flex-col h-full">
      <SidebarSectionHeader
        title=""
        actions={
          <>
            <NotificationBell />
            <SidebarHeaderButton onClick={handleNewWorkspace} title="New Workspace">
              <Plus size={13} />
            </SidebarHeaderButton>
            <SidebarHeaderButton onClick={handleCollapse} title="Collapse sidebar (⌘\\)">
              <SidebarToggleIcon size={13} direction="close" />
            </SidebarHeaderButton>
          </>
        }
      />

      {/* Scrollable workspace list */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        <div className="flex flex-col gap-1.5">
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
