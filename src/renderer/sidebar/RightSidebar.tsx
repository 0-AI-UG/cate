// =============================================================================
// RightSidebar — Collapsible, resizable right sidebar with tabbed content.
// Mirrors the left Sidebar's collapse/expand/resize mechanics.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useUIStore } from '../stores/uiStore'
import { GitBranch, ExternalLink } from 'lucide-react'
import { GitSidebarTab } from './GitSidebarTab'

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_WIDTH = 280
const MIN_WIDTH = 140
const MAX_WIDTH = 500
const COLLAPSED_WIDTH = 40

// -----------------------------------------------------------------------------
// Tab definitions
// -----------------------------------------------------------------------------

interface TabDef {
  id: string
  icon: React.ReactNode
  label: string
  component: React.FC
}

const TABS: TabDef[] = [
  {
    id: 'git',
    icon: <GitBranch size={16} />,
    label: 'Git',
    component: GitSidebarTab,
  },
]

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export const RightSidebar: React.FC = () => {
  const isVisible = useUIStore((s) => s.rightSidebarVisible)
  const activeTab = useUIStore((s) => s.rightSidebarActiveTab)
  const isDetached = useUIStore((s) => s.rightSidebarDetached)
  const toggleRightSidebar = useUIStore((s) => s.toggleRightSidebar)
  const setRightSidebarTab = useUIStore((s) => s.setRightSidebarTab)
  const setRightSidebarDetached = useUIStore((s) => s.setRightSidebarDetached)
  const setRightSidebarVisible = useUIStore((s) => s.setRightSidebarVisible)

  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  // ---------------------------------------------------------------------------
  // Left-edge resize (drag handle on the left side)
  // ---------------------------------------------------------------------------

  const handleResizeMouseDown = useCallback(
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

    let rafPending = false
    const handleMouseMove = (e: MouseEvent) => {
      if (rafPending) return
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        // Dragging left = larger width (opposite of left sidebar)
        const delta = startXRef.current - e.clientX
        const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta))
        setWidth(newWidth)
      })
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  // ---------------------------------------------------------------------------
  // Tab click
  // ---------------------------------------------------------------------------

  const handleTabClick = useCallback(
    (tabId: string) => {
      if (isVisible && activeTab === tabId) {
        toggleRightSidebar()
      } else {
        setRightSidebarTab(tabId)
      }
    },
    [isVisible, activeTab, toggleRightSidebar, setRightSidebarTab],
  )

  // ---------------------------------------------------------------------------
  // Detach / Reattach
  // ---------------------------------------------------------------------------

  const handleDetach = useCallback(async () => {
    await window.electronAPI.detachPanel({
      title: TABS.find((t) => t.id === activeTab)?.label || 'Sidebar',
      width,
      height: window.innerHeight,
    })
    setRightSidebarDetached(true)
    setRightSidebarVisible(false)
  }, [activeTab, width, setRightSidebarDetached, setRightSidebarVisible])

  const handleReattach = useCallback(() => {
    setRightSidebarDetached(false)
    setRightSidebarVisible(true)
  }, [setRightSidebarDetached, setRightSidebarVisible])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const ActiveComponent = TABS.find((t) => t.id === activeTab)?.component

  return (
    <div className="flex-shrink-0 flex h-full">
      {/* Expanded content area */}
      {isVisible && !isDetached && (
        <div
          className="relative flex flex-col h-full bg-canvas-bg border-l border-white/10 overflow-hidden"
          style={{ width: `${width}px` }}
        >
          {/* macOS titlebar drag region */}
          <div className="h-7 flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

          {/* Tab header with detach button */}
          <div className="flex items-center justify-between px-2 py-1 border-b border-white/[0.05]">
            <span className="text-xs text-white/50 uppercase">
              {TABS.find((t) => t.id === activeTab)?.label}
            </span>
            <button
              onClick={handleDetach}
              className="text-white/30 hover:text-white/60 p-1 rounded hover:bg-white/10 transition-colors"
              title="Detach to window"
            >
              <ExternalLink size={12} />
            </button>
          </div>

          {/* Tab content */}
          <div className="flex-1 min-h-0">
            {ActiveComponent && <ActiveComponent />}
          </div>

          {/* Left edge resize handle */}
          <div
            className={`absolute top-0 left-0 w-[6px] h-full cursor-col-resize z-10 ${
              isResizing ? 'bg-blue-500/30' : ''
            }`}
            onMouseDown={handleResizeMouseDown}
          />
        </div>
      )}

      {/* Detached placeholder */}
      {isDetached && (
        <div className="relative flex flex-col items-center justify-center h-full bg-canvas-bg border-l border-white/10 px-4" style={{ width: `${COLLAPSED_WIDTH + 80}px` }}>
          <div className="h-7 flex-shrink-0 w-full" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
          <span className="text-xs text-white/30 mb-2">Detached</span>
          <button
            onClick={handleReattach}
            className="text-xs text-white/50 hover:text-white/80 px-2 py-1 rounded bg-white/5 hover:bg-white/10 transition-colors"
          >
            Reattach
          </button>
        </div>
      )}

      {/* Icon strip (always visible) */}
      <div
        className="flex-shrink-0 flex flex-col items-center h-full bg-canvas-bg border-l border-white/10 select-none"
        style={{ width: `${COLLAPSED_WIDTH}px` }}
      >
        {/* macOS titlebar drag region */}
        <div className="h-7 w-full flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

        <div className="flex flex-col items-center gap-1 py-2">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`relative p-1.5 rounded transition-colors ${
                isVisible && activeTab === tab.id
                  ? 'text-white/80 bg-white/10'
                  : 'text-white/40 hover:text-white/70 hover:bg-white/10'
              }`}
              onClick={() => handleTabClick(tab.id)}
              title={tab.label}
            >
              {/* Active indicator */}
              {isVisible && activeTab === tab.id && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-4 bg-white/60 rounded-r" />
              )}
              {tab.icon}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
