// =============================================================================
// FileExplorerSidebar — Collapsible second sidebar showing the file tree.
// Renders next to the workspace sidebar, hidden by default.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { FileExplorer } from './FileExplorer'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { FolderOpen } from '@phosphor-icons/react'

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_WIDTH = 240
const MIN_WIDTH = 160
const MAX_WIDTH = 500

export const FileExplorerSidebar: React.FC = () => {
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [isResizing, setIsResizing] = useState(false)

  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  const fileExplorerVisible = useUIStore((s) => s.fileExplorerVisible)

  const selectedWorkspace = useAppStore((s) => {
    const id = s.selectedWorkspaceId
    return s.workspaces.find((w) => w.id === id)
  })
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const setWorkspaceRootPath = useAppStore((s) => s.setWorkspaceRootPath)

  const rootPath = selectedWorkspace?.rootPath ?? ''

  // ---------------------------------------------------------------------------
  // Width resize (right edge drag handle)
  // ---------------------------------------------------------------------------

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setIsResizing(true)
      startXRef.current = e.clientX
      startWidthRef.current = width
    },
    [width],
  )

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startXRef.current
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta))
      setWidth(newWidth)
    }

    const handleMouseUp = () => setIsResizing(false)

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      className="flex-shrink-0 relative flex flex-col h-full bg-canvas-bg border-r border-subtle select-none overflow-hidden"
      style={{
        width: fileExplorerVisible ? `${width}px` : '0px',
        minWidth: fileExplorerVisible ? `${MIN_WIDTH}px` : '0px',
        transition: 'width 200ms ease-in-out, min-width 200ms ease-in-out',
      }}
    >
      {fileExplorerVisible && (
        <>
          {/* File explorer content */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {rootPath ? (
              <FileExplorer rootPath={rootPath} />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-muted text-xs gap-3 p-4">
                <span>No folder open</span>
                <button
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-secondary hover:text-primary bg-surface-5 hover:bg-hover transition-colors"
                  onClick={async () => {
                    const path = await window.electronAPI.openFolderDialog()
                    if (!path) return
                    const appState = useAppStore.getState()
                    let wsId = appState.selectedWorkspaceId
                    // Create a workspace if none exists
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

          {/* Right edge resize handle */}
          <div
            className={`absolute top-0 right-0 w-[6px] h-full cursor-col-resize z-10 ${
              isResizing ? 'bg-blue-500/30' : ''
            }`}
            onMouseDown={handleMouseDown}
          />
        </>
      )}
    </div>
  )
}
