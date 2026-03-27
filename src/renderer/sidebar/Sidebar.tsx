// =============================================================================
// Sidebar — Main sidebar container with resizable width, project list,
// and optional file explorer.
// Ported from the SwiftUI sidebar + SidebarResizers.swift
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ProjectList } from './ProjectList'
import { FileExplorer } from './FileExplorer'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { FolderOpen } from 'lucide-react'

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_WIDTH = 220
const MIN_WIDTH = 140
const MAX_WIDTH = 500

const DEFAULT_DIVIDER_POSITION = 0.5 // fraction of available height

interface SidebarProps {
  isVisible: boolean
}

export const Sidebar: React.FC<SidebarProps> = ({ isVisible }) => {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [isResizingWidth, setIsResizingWidth] = useState(false)
  const [showFileExplorer, setShowFileExplorer] = useState(false)
  const [dividerFraction, setDividerFraction] = useState(DEFAULT_DIVIDER_POSITION)
  const [isResizingDivider, setIsResizingDivider] = useState(false)

  const sidebarRef = useRef<HTMLDivElement>(null)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  const startYRef = useRef(0)
  const startFractionRef = useRef(0)

  const selectedWorkspace = useAppStore((s) => {
    const id = s.selectedWorkspaceId
    return s.workspaces.find((w) => w.id === id)
  })
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const setWorkspaceRootPath = useAppStore((s) => s.setWorkspaceRootPath)

  const showFileExplorerOnLaunch = useSettingsStore((s) => s.showFileExplorerOnLaunch)

  // Initialise file explorer visibility from settings
  useEffect(() => {
    setShowFileExplorer(showFileExplorerOnLaunch)
  }, [showFileExplorerOnLaunch])

  // ---------------------------------------------------------------------------
  // Width resize (right edge drag handle)
  // ---------------------------------------------------------------------------

  const handleWidthMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setIsResizingWidth(true)
      startXRef.current = e.clientX
      startWidthRef.current = width
    },
    [width],
  )

  useEffect(() => {
    if (!isResizingWidth) return

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startXRef.current
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta))
      setWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizingWidth(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizingWidth])

  // ---------------------------------------------------------------------------
  // Section divider resize
  // ---------------------------------------------------------------------------

  const handleDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setIsResizingDivider(true)
      startYRef.current = e.clientY
      startFractionRef.current = dividerFraction
    },
    [dividerFraction],
  )

  useEffect(() => {
    if (!isResizingDivider) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!sidebarRef.current) return
      const sidebarHeight = sidebarRef.current.clientHeight - 28 - 32 // minus titlebar and footer
      if (sidebarHeight <= 0) return
      const delta = e.clientY - startYRef.current
      const fractionDelta = delta / sidebarHeight
      const newFraction = Math.min(0.85, Math.max(0.15, startFractionRef.current + fractionDelta))
      setDividerFraction(newFraction)
    }

    const handleMouseUp = () => {
      setIsResizingDivider(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizingDivider])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const rootPath = selectedWorkspace?.rootPath ?? ''

  return (
    <div
      ref={sidebarRef}
      className="flex-shrink-0 relative flex flex-col h-full bg-canvas-bg border-r border-white/10 select-none overflow-hidden"
      style={{
        width: `${width}px`,
        marginLeft: isVisible ? 0 : `-${width}px`,
        transition: 'margin-left 200ms ease-in-out',
      }}
    >
      {/* macOS titlebar drag region */}
      <div className="h-7 flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

      {/* Project list section */}
      <div
        className="flex-shrink-0 overflow-hidden"
        style={{
          height: showFileExplorer ? `${dividerFraction * 100}%` : undefined,
          flex: showFileExplorer ? undefined : '1 1 auto',
        }}
      >
        <ProjectList />
      </div>

      {/* Section divider (only when file explorer is visible) */}
      {showFileExplorer && (
        <div
          className={`h-[1px] flex-shrink-0 cursor-row-resize ${
            isResizingDivider ? 'bg-blue-500/60 h-[2px]' : 'bg-white/10'
          }`}
          onMouseDown={handleDividerMouseDown}
          style={{ margin: '0' }}
        />
      )}

      {/* File explorer section */}
      {showFileExplorer && (
        <div className="flex-1 min-h-0 overflow-hidden">
          {rootPath ? (
            <FileExplorer rootPath={rootPath} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-white/30 text-xs gap-3 p-4">
              <span>No folder open</span>
              <button
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-white/50 hover:text-white/80 bg-white/5 hover:bg-white/10 transition-colors"
                onClick={async () => {
                  const path = await window.electronAPI.openFolderDialog()
                  if (path && selectedWorkspaceId) {
                    setWorkspaceRootPath(selectedWorkspaceId, path)
                  }
                }}
              >
                <FolderOpen size={13} />
                Open Folder
              </button>
            </div>
          )}
        </div>
      )}

      {/* Right edge resize handle */}
      <div
        className={`absolute top-0 right-0 w-[6px] h-full cursor-col-resize z-10 ${
          isResizingWidth ? 'bg-blue-500/30' : ''
        }`}
        onMouseDown={handleWidthMouseDown}
      />
    </div>
  )
}
