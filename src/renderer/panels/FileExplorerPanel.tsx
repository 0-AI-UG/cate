// =============================================================================
// FileExplorerPanel — Dockable panel wrapping the FileExplorer tree view.
// =============================================================================

import React from 'react'
import { FolderOpen } from 'lucide-react'
import { FileExplorer } from '../sidebar/FileExplorer'
import { useAppStore } from '../stores/appStore'
import type { PanelProps } from './types'

export default function FileExplorerPanel({ panelId, workspaceId }: PanelProps) {
  const rootPath = useAppStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws?.rootPath ?? ''
  })
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const setWorkspaceRootPath = useAppStore((s) => s.setWorkspaceRootPath)

  return (
    <div className="w-full h-full overflow-auto bg-[#1e1e1e] flex flex-col">
      {rootPath ? (
        <FileExplorer rootPath={rootPath} />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-white/30 text-xs gap-3 p-4">
          <span>No folder open</span>
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-white/50 hover:text-white/80 bg-white/5 hover:bg-white/10 transition-colors"
            onClick={async () => {
              const path = await window.electronAPI.openFolderDialog()
              if (!path) return
              const appState = useAppStore.getState()
              let wsId = workspaceId || appState.selectedWorkspaceId
              if (!wsId || !appState.workspaces.find((w) => w.id === wsId)) {
                wsId = appState.addWorkspace()
                appState.selectWorkspace(wsId)
              }
              appState.setWorkspaceRootPath(wsId, path)
            }}
          >
            <FolderOpen size={13} />
            Open Folder
          </button>
        </div>
      )}
    </div>
  )
}
