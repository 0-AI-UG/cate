import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ProjectList } from './ProjectList'
import { FileExplorer } from './FileExplorer'
import { SourceControlView } from './SourceControlView'
import { AIConfigSidebarView } from './AIConfigSidebarView'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import type { SidebarView } from '../stores/uiStore'
import { FolderOpen, GitBranch } from 'lucide-react'

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

export const Sidebar: React.FC<SidebarProps> = ({ isVisible }) => {
  const [width, setWidth] = useState(LEFT_DEFAULT_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  const toggleSidebar = useUIStore((s) => s.toggleSidebar)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
    startXRef.current = e.clientX
    startWidthRef.current = width
  }, [width])

  useEffect(() => {
    if (!isResizing) return
    let raf = false
    const onMove = (e: MouseEvent) => {
      if (raf) return
      raf = true
      requestAnimationFrame(() => {
        raf = false
        const delta = e.clientX - startXRef.current
        setWidth(Math.min(LEFT_MAX_WIDTH, Math.max(LEFT_MIN_WIDTH, startWidthRef.current + delta)))
      })
    }
    const onUp = () => setIsResizing(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [isResizing])

  if (!isVisible) return null

  return (
    <div
      className="flex-shrink-0 relative flex flex-col h-full bg-canvas-bg border-r border-white/10 select-none overflow-hidden"
      style={{ width: `${width}px` }}
    >
      {/* macOS titlebar drag region */}
      <div className="h-7 flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

      <ProjectList />

      {/* Resize handle */}
      <div
        className={`absolute top-0 right-0 w-[6px] h-full cursor-col-resize z-10 ${isResizing ? 'bg-blue-500/30' : ''}`}
        onMouseDown={handleMouseDown}
      />
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
    let raf = false
    const onMove = (e: MouseEvent) => {
      if (raf) return
      raf = true
      requestAnimationFrame(() => {
        raf = false
        const delta = startXRef.current - e.clientX
        setWidth(Math.min(RIGHT_MAX_WIDTH, Math.max(RIGHT_MIN_WIDTH, startWidthRef.current + delta)))
      })
    }
    const onUp = () => setIsResizing(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
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
