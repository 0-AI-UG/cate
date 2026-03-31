import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ProjectList } from './ProjectList'
import { FileExplorer } from './FileExplorer'
import { SourceControlView } from './SourceControlView'
import { AIConfigSidebarView } from './AIConfigSidebarView'
import { useAppStore, useWorkspaceList } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { useStatusStore } from '../stores/statusStore'
import type { SidebarView } from '../stores/uiStore'
import { Bell, ChevronLeft, ChevronRight, FolderOpen, GitBranch, Plus } from 'lucide-react'

// Custom agent setup icon — bottle/flask shape, matches lucide stroke style
const AgentSetupIcon = React.forwardRef<SVGSVGElement, React.SVGProps<SVGSVGElement> & { size?: number | string }>(
  ({ size = 24, ...props }, ref) => (
    <svg ref={ref} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      {/* Bottle cap */}
      <path d="M9 2h6v3H9z" />
      {/* Neck */}
      <path d="M10 5v3" />
      <path d="M14 5v3" />
      {/* Body — curved bottle shape */}
      <path d="M10 8c-3 2-4 5-4 8a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4c0-3-1-6-4-8" />
    </svg>
  ),
)

// ---------------------------------------------------------------------------
// Left Sidebar — Workspaces only
// ---------------------------------------------------------------------------

const LEFT_DEFAULT_WIDTH = 220
const LEFT_MIN_WIDTH = 140
const LEFT_MAX_WIDTH = 400

interface SidebarProps {
  isVisible: boolean
}

const LEFT_COLLAPSED_WIDTH = 36

export const Sidebar: React.FC<SidebarProps> = ({ isVisible }) => {
  const [width, setWidth] = useState(LEFT_DEFAULT_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const workspaces = useWorkspaceList()
  const addWorkspace = useAppStore((s) => s.addWorkspace)
  const selectWorkspace = useAppStore((s) => s.selectWorkspace)
  const needsInputCount = useStatusStore((s) => {
    let count = 0
    for (const ws of workspaces) {
      if (s.isAnimating(ws.id)) count++
    }
    return count
  })

  const handleNewWorkspace = useCallback(() => {
    const wsId = addWorkspace()
    selectWorkspace(wsId)
  }, [addWorkspace, selectWorkspace])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
    startXRef.current = e.clientX
    startWidthRef.current = width
  }, [width])

  useEffect(() => {
    if (!isResizing) return
    let pendingX = startXRef.current
    let rafId = 0
    const onMove = (e: MouseEvent) => {
      pendingX = e.clientX
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0
          const delta = pendingX - startXRef.current
          setWidth(Math.min(LEFT_MAX_WIDTH, Math.max(LEFT_MIN_WIDTH, startWidthRef.current + delta)))
        })
      }
    }
    const onUp = () => setIsResizing(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isResizing])

  return (
    <div
      className="flex-shrink-0 relative flex flex-col h-full bg-canvas-bg border-r border-white/10 select-none overflow-hidden transition-[width] duration-200 ease-in-out"
      style={{ width: isVisible ? `${width}px` : `${LEFT_COLLAPSED_WIDTH}px` }}
    >
      {/* macOS titlebar drag region */}
      <div className="h-7 flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

      {/* When collapsed: show workspace dots + action icons */}
      {!isVisible && (
        <div className="flex flex-col items-center gap-1 py-2 flex-shrink-0">
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
            onClick={handleNewWorkspace}
            title="New Workspace"
          >
            <Plus size={16} />
          </button>
          <div className="w-5 border-t border-white/10 my-1" />
          {workspaces.map((ws) => {
            const isSelected = ws.id === useAppStore.getState().selectedWorkspaceId
            const panelCount = Object.keys(ws.panels).length
            const label = ws.name || ws.rootPath?.split('/').pop() || 'Workspace'
            return (
              <button
                key={ws.id}
                className={`relative flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
                  isSelected ? 'ring-1 ring-white/30' : 'hover:bg-white/10'
                }`}
                style={{ backgroundColor: isSelected ? ws.color : `${ws.color}66` }}
                onClick={() => selectWorkspace(ws.id)}
                title={label}
              >
                <span className="text-[10px] font-bold text-white">
                  {panelCount > 0 ? panelCount : label.charAt(0).toUpperCase()}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* Workspace list with icon toolbar — hidden when collapsed */}
      <div className={`min-h-0 overflow-hidden transition-opacity duration-200 ${isVisible ? 'flex-1 opacity-100' : 'h-0 opacity-0'}`}>
        <ProjectList />
      </div>

      <div className="flex-1" />

      <div className="flex-shrink-0 border-t border-white/10 p-1.5">
        <button
          className="flex items-center justify-center w-full h-6 rounded text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors"
          onClick={toggleSidebar}
          title={isVisible ? 'Collapse sidebar (⌘\\)' : 'Expand sidebar (⌘\\)'}
        >
          {isVisible ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
        </button>
      </div>

      {/* Resize handle (only when expanded) */}
      {isVisible && (
        <div
          className={`absolute top-0 right-0 w-[6px] h-full cursor-col-resize z-10 ${isResizing ? 'bg-blue-500/30' : ''}`}
          onMouseDown={handleMouseDown}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Right Sidebar — Activity bar with explorer, git, etc.
// ---------------------------------------------------------------------------

const RIGHT_VIEWS: { view: SidebarView; icon: typeof FolderOpen; title: string }[] = [
  { view: 'explorer', icon: FolderOpen, title: 'Explorer' },
  { view: 'git', icon: GitBranch, title: 'Source Control' },
  { view: 'aiConfig', icon: AgentSetupIcon as any, title: 'Agent Setup' },
]

const RIGHT_DEFAULT_WIDTH = 260
const RIGHT_MIN_WIDTH = 200
const RIGHT_MAX_WIDTH = 500
const RIGHT_BAR_WIDTH = 40

const RightViewContent: React.FC<{ view: SidebarView; rootPath: string }> = ({ view, rootPath }) => {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const setWorkspaceRootPath = useAppStore((s) => s.setWorkspaceRootPath)

  switch (view) {
    case 'explorer':
      return rootPath ? (
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
      )
    case 'git':
      return <SourceControlView rootPath={rootPath} />
    case 'aiConfig':
      return <AIConfigSidebarView rootPath={rootPath} workspaceId={selectedWorkspaceId} />
    default:
      return null
  }
}

export const RightSidebar: React.FC = () => {
  const activeView = useUIStore((s) => s.activeRightSidebarView)
  const setActiveView = useUIStore((s) => s.setActiveRightSidebarView)
  const isExpanded = activeView !== null

  const [width, setWidth] = useState(RIGHT_DEFAULT_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  const selectedWorkspace = useAppStore((s) => {
    const id = s.selectedWorkspaceId
    return s.workspaces.find((w) => w.id === id)
  })
  const rootPath = selectedWorkspace?.rootPath ?? ''

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
    startXRef.current = e.clientX
    startWidthRef.current = width
  }, [width])

  useEffect(() => {
    if (!isResizing) return
    let pendingX = startXRef.current
    let rafId = 0
    const onMove = (e: MouseEvent) => {
      pendingX = e.clientX
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0
          const delta = startXRef.current - pendingX
          setWidth(Math.min(RIGHT_MAX_WIDTH, Math.max(RIGHT_MIN_WIDTH, startWidthRef.current + delta)))
        })
      }
    }
    const onUp = () => setIsResizing(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isResizing])

  const handleIconClick = useCallback((view: SidebarView) => {
    // Toggle: click active view to collapse, click another to switch
    if (activeView === view) {
      setActiveView(null)
    } else {
      setActiveView(view)
    }
  }, [activeView, setActiveView])

  return (
    <div
      className="flex-shrink-0 relative flex flex-row h-full bg-canvas-bg border-l border-white/10 select-none overflow-hidden"
      style={{ width: isExpanded ? `${width}px` : `${RIGHT_BAR_WIDTH}px` }}
    >
      {/* Content area (left of icons when expanded) */}
      {isExpanded && activeView && (
        <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
          <div className="h-7 flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
          <div className="flex-1 min-h-0 overflow-hidden">
            <RightViewContent view={activeView} rootPath={rootPath} />
          </div>
        </div>
      )}

      {/* Activity bar icons — always visible on the right edge */}
      <div className={`flex-shrink-0 flex flex-col items-center w-10 h-full ${isExpanded ? 'border-l border-white/10' : ''}`}>
        <div className="h-7 w-full flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
        <div className="flex flex-col items-center gap-1 pt-[7px] w-full">
          {RIGHT_VIEWS.map(({ view, icon: Icon, title }) => {
            const isActive = activeView === view
            return (
              <button
                key={view}
                className={`relative flex items-center justify-center w-9 h-8 rounded transition-colors ${
                  isActive
                    ? 'text-white/90'
                    : 'text-white/30 hover:text-white/60'
                }`}
                onClick={() => handleIconClick(view)}
                title={title}
              >
                {isActive && (
                  <div className="absolute right-0 top-1.5 bottom-1.5 w-[2px] bg-white/80 rounded-l" />
                )}
                <Icon size={18} strokeWidth={1.5} />
              </button>
            )
          })}
        </div>
      </div>

      {/* Resize handle (left edge, only when expanded) */}
      {isExpanded && (
        <div
          className={`absolute top-0 left-0 w-[6px] h-full cursor-col-resize z-10 ${isResizing ? 'bg-blue-500/30' : ''}`}
          onMouseDown={handleMouseDown}
        />
      )}
    </div>
  )
}
