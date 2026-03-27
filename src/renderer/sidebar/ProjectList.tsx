import React from 'react'
import { PanelLeft, Bell, Plus } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { useStatusStore } from '../stores/statusStore'
import { WorkspaceTab } from './WorkspaceTab'

interface ProjectListProps {
  onToggleFileExplorer?: () => void
}

export const ProjectList: React.FC<ProjectListProps> = ({ onToggleFileExplorer }) => {
  const workspaces = useAppStore((s) => s.workspaces)
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const addWorkspace = useAppStore((s) => s.addWorkspace)
  const selectWorkspace = useAppStore((s) => s.selectWorkspace)
  const removeWorkspace = useAppStore((s) => s.removeWorkspace)

  const needsInputCount = useStatusStore((s) => {
    let count = 0
    for (const ws of workspaces) {
      if (s.isAnimating(ws.id)) count++
    }
    return count
  })

  return (
    <div className="flex flex-col h-full">
      {/* Icon toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 flex-shrink-0">
        <button
          className="text-white/40 hover:text-white/70 transition-colors p-1"
          onClick={onToggleFileExplorer}
          title="Toggle File Explorer"
        >
          <PanelLeft size={16} />
        </button>

        <button
          className="relative text-white/40 hover:text-white/70 transition-colors p-1"
          title="Notifications"
        >
          <Bell size={16} />
          {needsInputCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 bg-blue-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
              {needsInputCount}
            </span>
          )}
        </button>

        <button
          className="text-white/40 hover:text-white/70 transition-colors p-1"
          onClick={() => addWorkspace()}
          title="New Workspace"
        >
          <Plus size={16} />
        </button>
      </div>

      {/* Scrollable workspace list */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        <div className="flex flex-col gap-1.5">
          {workspaces.map((ws) => (
            <WorkspaceTab
              key={ws.id}
              workspace={ws}
              isSelected={ws.id === selectedWorkspaceId}
              onClick={() => selectWorkspace(ws.id)}
              onClose={() => removeWorkspace(ws.id)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
