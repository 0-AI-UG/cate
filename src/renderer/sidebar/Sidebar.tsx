import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ProjectList } from './ProjectList'
import { FileExplorer } from './FileExplorer'
import { SourceControlView } from './SourceControlView'
import { AIConfigSidebarView } from './AIConfigSidebarView'
import { UsageSidebarView } from './UsageSidebarView'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import type { SidebarView, SidebarSide } from '../stores/uiStore'
import {
  Pulse,
  Flask,
  FolderOpen,
  GitBranch,
  Stack,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react'
import pkg from '../../../package.json'

// ---------------------------------------------------------------------------
// View metadata — icon + title for each possible sidebar view
// ---------------------------------------------------------------------------

const VIEW_META: Record<SidebarView, { icon: PhosphorIcon; title: string }> = {
  workspaces: { icon: Stack, title: 'Workspaces' },
  explorer: { icon: FolderOpen, title: 'Explorer' },
  git: { icon: GitBranch, title: 'Source Control' },
  aiConfig: { icon: Flask, title: 'Agent Setup' },
  usage: { icon: Pulse, title: 'Token Usage' },
}

// ---------------------------------------------------------------------------
// Content renderer — renders whichever view is active, regardless of side
// ---------------------------------------------------------------------------

const SidebarViewContent: React.FC<{ view: SidebarView; rootPath: string; onCollapse: () => void }> = ({
  view,
  rootPath,
  onCollapse,
}) => {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const setWorkspaceRootPath = useAppStore((s) => s.setWorkspaceRootPath)

  switch (view) {
    case 'workspaces':
      return <ProjectList onCollapse={onCollapse} />
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
    case 'usage':
      return <UsageSidebarView />
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Shared activity bar sidebar — parameterized by side
// ---------------------------------------------------------------------------

const DRAG_MIME = 'application/x-cate-view'
const BAR_WIDTH = 40

interface ActivityBarSidebarProps {
  side: SidebarSide
  defaultWidth: number
  minWidth: number
  maxWidth: number
}

const ActivityBarSidebar: React.FC<ActivityBarSidebarProps> = ({ side, defaultWidth, minWidth, maxWidth }) => {
  const layout = useUIStore((s) => s.sidebarLayout)
  const views = layout[side]
  const activeView = useUIStore((s) => (side === 'left' ? s.activeLeftSidebarView : s.activeRightSidebarView))
  const setActiveView = useUIStore((s) =>
    side === 'left' ? s.setActiveLeftSidebarView : s.setActiveRightSidebarView,
  )
  const moveSidebarView = useUIStore((s) => s.moveSidebarView)
  const draggingView = useUIStore((s) => s.draggingView)
  const setDraggingView = useUIStore((s) => s.setDraggingView)
  const isDragActive = draggingView !== null

  // Guard: if activeView is not present on this side (e.g. just moved away), clear it
  useEffect(() => {
    if (activeView !== null && !views.includes(activeView)) {
      setActiveView(null)
    }
  }, [activeView, views, setActiveView])

  const isExpanded = activeView !== null
  const isEmpty = views.length === 0
  // When empty, the sidebar is hidden. During a drag, if the cursor enters
  // this side's half of the window, we reveal it so the user can drop here.
  const [dragRevealed, setDragRevealed] = useState(false)
  useEffect(() => {
    if (!isDragActive || !isEmpty) {
      setDragRevealed(false)
      return
    }
    const onDragOver = (e: DragEvent) => {
      const half = window.innerWidth / 2
      const inside = side === 'left' ? e.clientX < half : e.clientX >= half
      setDragRevealed(inside)
    }
    window.addEventListener('dragover', onDragOver)
    return () => window.removeEventListener('dragover', onDragOver)
  }, [isDragActive, isEmpty, side])

  const [width, setWidth] = useState(defaultWidth)
  const [isResizing, setIsResizing] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  // Drop indicator: index where the drop would land. Mirrored in a ref so the
  // drop handler reads the latest value (state updates from dragOver may not
  // have flushed by the time drop fires).
  const [dropIndicator, setDropIndicatorState] = useState<number | null>(null)
  const dropIndicatorRef = useRef<number | null>(null)
  const setDropIndicator = useCallback((value: number | null | ((prev: number | null) => number | null)) => {
    const next = typeof value === 'function' ? value(dropIndicatorRef.current) : value
    dropIndicatorRef.current = next
    setDropIndicatorState(next)
  }, [])

  const selectedWorkspace = useAppStore((s) => {
    const id = s.selectedWorkspaceId
    return s.workspaces.find((w) => w.id === id)
  })
  const rootPath = selectedWorkspace?.rootPath ?? ''

  const handleResizeDown = useCallback((e: React.MouseEvent) => {
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
          // Left: dragging right grows width; Right: dragging left grows width.
          const delta = side === 'left' ? pendingX - startXRef.current : startXRef.current - pendingX
          setWidth(Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + delta)))
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
  }, [isResizing, side, minWidth, maxWidth])

  const handleIconClick = useCallback((view: SidebarView) => {
    if (activeView === view) setActiveView(null)
    else setActiveView(view)
  }, [activeView, setActiveView])

  const handleCollapse = useCallback(() => setActiveView(null), [setActiveView])

  // --- Drag handlers ---

  const handleIconDragStart = (e: React.DragEvent, view: SidebarView) => {
    e.dataTransfer.setData(DRAG_MIME, view)
    e.dataTransfer.setData('text/plain', view)
    e.dataTransfer.effectAllowed = 'move'
    setDraggingView(view)
  }

  const handleIconDragEnd = () => {
    setDraggingView(null)
    setDropIndicator(null)
  }

  const iconsContainerRef = useRef<HTMLDivElement | null>(null)

  const computeDropIndex = (clientY: number): number => {
    const container = iconsContainerRef.current
    if (!container) return views.length
    const buttons = Array.from(container.querySelectorAll<HTMLElement>('[data-sidebar-icon]'))
    if (buttons.length === 0) return 0
    for (let i = 0; i < buttons.length; i++) {
      const rect = buttons[i].getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) return i
    }
    return buttons.length
  }

  const handleBarDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleBarDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDropIndicator(computeDropIndex(e.clientY))
  }

  const handleBarDragLeave = (e: React.DragEvent) => {
    // Only clear when leaving the bar entirely
    const related = e.relatedTarget as Node | null
    if (!related || !(e.currentTarget as HTMLElement).contains(related)) {
      setDropIndicator(null)
    }
  }

  const handleBarDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const view = ((e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain')) as SidebarView) || draggingView
    // Compute index fresh from cursor position — relying on the indicator
    // ref is unsafe because dragleave with null relatedTarget can clear it
    // immediately before drop fires.
    const targetIndex = computeDropIndex(e.clientY)
    setDropIndicator(null)
    setDraggingView(null)
    if (!view) return
    moveSidebarView(view, side, targetIndex)
  }

  // --- Render ---

  const bar = (
    <div
      className={`flex-shrink-0 flex flex-col items-center h-full relative ${
        isExpanded ? 'bg-[#141311]' : ''
      }`}
      style={{ width: BAR_WIDTH }}
      onDragEnter={handleBarDragEnter}
      onDragOver={handleBarDragOver}
      onDragLeave={handleBarDragLeave}
      onDrop={handleBarDrop}
    >
      <div ref={iconsContainerRef} className="flex flex-col items-center pt-[7px] w-full relative">
        {views.map((view, index) => {
          const meta = VIEW_META[view]
          const Icon = meta.icon
          const isActive = activeView === view
          const showIndicatorBefore = isDragActive && dropIndicator === index
          const showIndicatorAfter = isDragActive && index === views.length - 1 && dropIndicator === views.length
          return (
            <React.Fragment key={view}>
              {showIndicatorBefore && (
                <div className="w-7 h-[2px] my-0.5 bg-blue-400 rounded-full pointer-events-none" />
              )}
              <div className="relative w-full flex items-center justify-center">
              <div
                role="button"
                tabIndex={0}
                data-sidebar-icon=""
                draggable
                onDragStart={(e) => handleIconDragStart(e, view)}
                onDragEnd={handleIconDragEnd}
                className={`relative flex items-center justify-center w-9 h-8 my-0.5 rounded transition-colors cursor-pointer ${
                  isActive ? 'text-white/90' : 'text-white/30 hover:text-white/60'
                }`}
                onClick={() => handleIconClick(view)}
                title={meta.title}
              >
                {isActive && (
                  <div
                    className={`absolute top-1.5 bottom-1.5 w-[2px] bg-white/80 pointer-events-none ${
                      side === 'left' ? 'left-0 rounded-r' : 'right-0 rounded-l'
                    }`}
                  />
                )}
                <Icon size={18} className="pointer-events-none" />
              </div>
            </div>
              {showIndicatorAfter && (
                <div className="w-7 h-[2px] my-0.5 bg-blue-400 rounded-full pointer-events-none" />
              )}
            </React.Fragment>
          )
        })}
        {isDragActive && views.length === 0 && dropIndicator !== null && (
          <div className="w-7 h-[2px] my-0.5 bg-blue-400 rounded-full pointer-events-none" />
        )}
      </div>
    </div>
  )

  const content = (
    <div
      className={`flex-1 min-w-0 flex flex-col h-full overflow-hidden transition-opacity duration-200 relative ${
        isExpanded ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {activeView && (
          <div key={activeView} className="absolute inset-0 animate-sidebar-view-in">
            <SidebarViewContent view={activeView} rootPath={rootPath} onCollapse={handleCollapse} />
          </div>
        )}
      </div>
      {/* Version marker — shown on whichever side hosts the workspaces view */}
      {isExpanded && activeView === 'workspaces' && (
        <div className="flex-shrink-0 px-2 py-1.5 flex items-center justify-center gap-1.5 select-none">
          <svg viewBox="0 0 389 204" className="h-3 w-auto text-white/25" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-label="Cate">
            <path d="M274 203.2L307.29 1.79999H388.29L384.51 24.84H329.97L320.5 80.16H342.22H366.34L362.74 103.2H338.62H316.5L304.06 180.16H358.6L355 203.2H314.5H274Z" />
            <path d="M201.264 203.2L230.424 26.5H197.124L201.264 1.3H294.864L290.724 26.5H257.424L228.264 203.2H201.264Z" />
            <path d="M89 133.2L142.1 1.79999H176.3L188 133.2H161.18L159.56 103.5H128.24L117.26 133.2H89ZM136.16 81.9H158.3L157.04 50.22C156.92 45.66 156.68 41.16 156.32 36.72C156.08 32.16 155.9 28.62 155.78 26.1C154.94 28.62 153.8 32.1 152.36 36.54C151.04 40.98 149.54 45.48 147.86 50.04L136.16 81.9Z" />
            <path d="M38.1825 135C29.4225 135 21.9825 133.38 15.8625 130.14C9.7425 126.78 5.3625 122.16 2.7225 116.28C0.0824997 110.28 -0.6375 103.32 0.5625 95.4L9.3825 39.6C10.7025 31.56 13.6425 24.6 18.2025 18.72C22.7625 12.84 28.5825 8.27999 35.6625 5.04C42.8625 1.68 50.8425 0 59.6025 0C68.4825 0 75.9225 1.68 81.9225 5.04C87.9225 8.27999 92.3025 12.84 95.0625 18.72C97.8225 24.6 98.5425 31.56 97.2225 39.6H70.2225C71.1825 34.32 70.4025 30.3 67.8825 27.54C65.3625 24.78 61.4025 23.4 56.0025 23.4C50.6025 23.4 46.2225 24.78 42.8625 27.54C39.5025 30.3 37.3425 34.32 36.3825 39.6L27.5625 95.4C26.7225 100.56 27.5625 104.58 30.0825 107.46C32.6025 110.22 36.5625 111.6 41.9625 111.6C47.3625 111.6 51.7425 110.22 55.1025 107.46C58.4625 104.58 60.5625 100.56 61.4025 95.4H88.4025C87.2025 103.32 84.2625 110.28 79.5825 116.28C75.0225 122.16 69.2025 126.78 62.1225 130.14C55.0425 133.38 47.0625 135 38.1825 135Z" />
          </svg>
          <span className="text-[10px] text-white/25">v{pkg.version}</span>
        </div>
      )}
    </div>
  )

  return (
    <div
      className={`flex-shrink-0 relative flex flex-row h-full bg-[#161513] select-none overflow-hidden ${
        isResizing ? '' : 'transition-[width] duration-200 ease-in-out'
      }`}
      style={{
        width:
          isEmpty && !dragRevealed
            ? 0
            : isExpanded
              ? BAR_WIDTH + width
              : BAR_WIDTH,
      }}
    >
      {side === 'left' ? (
        <>
          {bar}
          {content}
        </>
      ) : (
        <>
          {content}
          {bar}
        </>
      )}

      {/* Resize handle on the inner edge, only when expanded */}
      {isExpanded && (
        <div
          className={`absolute top-0 ${side === 'left' ? 'right-0' : 'left-0'} w-[6px] h-full cursor-col-resize z-10 ${
            isResizing ? 'bg-blue-500/30' : ''
          }`}
          onMouseDown={handleResizeDown}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Public wrappers
// ---------------------------------------------------------------------------

export const Sidebar: React.FC = () => (
  <ActivityBarSidebar side="left" defaultWidth={220} minWidth={140} maxWidth={400} />
)

export const RightSidebar: React.FC = () => (
  <ActivityBarSidebar side="right" defaultWidth={340} minWidth={240} maxWidth={600} />
)
