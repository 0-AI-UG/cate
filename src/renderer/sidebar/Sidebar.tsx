import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ProjectList } from './ProjectList'
import { FileExplorer } from './FileExplorer'
import { SearchView } from './SearchView'
import { SourceControlView } from './SourceControlView'
import { CateAgentSidebarView } from '../cateAgent/CateAgentSidebarView'
import { useAppStore } from '../stores/appStore'
import { useUIStore, useSidebarLayout } from '../stores/uiStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { SidebarView, SidebarSide } from '../stores/uiStore'
import {
  FolderOpen,
  GitBranch,
  Stack,
  Gear,
  MagnifyingGlass,
  FloppyDisk,
  PuzzlePiece,
  SidebarSimple,
} from '@phosphor-icons/react'
import pkg from '../../../package.json'
import { Tooltip } from '../ui/Tooltip'
import { CateLogo } from '../ui/CateLogo'
import { IS_MAC } from '../lib/platform'
import { MAC_CHROME_HEIGHT } from '../shells/MacWindowChrome'

// ---------------------------------------------------------------------------
// View metadata — icon + title for each possible sidebar view
// ---------------------------------------------------------------------------

// Icons are called as `<Icon size={n} className=… />`; Phosphor icons and the
// Cate wordmark both satisfy this call signature. A plain function type (rather
// than ComponentType) sidesteps the static propTypes clash between Phosphor's
// forward-ref icons and a custom SVG component.
type SidebarViewIcon = (props: { size?: number; className?: string }) => React.ReactNode

const VIEW_META: Record<SidebarView, { icon: SidebarViewIcon; title: string }> = {
  workspaces: { icon: Stack, title: 'Workspaces' },
  explorer: { icon: FolderOpen, title: 'Explorer' },
  search: { icon: MagnifyingGlass, title: 'Search' },
  git: { icon: GitBranch, title: 'Source Control' },
  cateAgent: { icon: CateLogo, title: 'Cate Agent' },
}

// ---------------------------------------------------------------------------
// Content renderer — renders whichever view is active, regardless of side
// ---------------------------------------------------------------------------

const SidebarViewContent: React.FC<{ view: SidebarView; rootPath: string }> = ({
  view,
  rootPath,
}) => {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const setWorkspaceRootPath = useAppStore((s) => s.setWorkspaceRootPath)

  switch (view) {
    case 'workspaces':
      return <ProjectList />
    case 'explorer':
      return rootPath ? (
        <FileExplorer rootPath={rootPath} />
      ) : (
        <div className="flex flex-col items-center justify-center h-full text-muted text-xs gap-3 p-4">
          <span>No folder open</span>
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-secondary hover:text-primary bg-surface-5 hover:bg-hover transition-colors"
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
    case 'search':
      return <SearchView rootPath={rootPath} workspaceId={selectedWorkspaceId} />
    case 'git':
      return <SourceControlView rootPath={rootPath} />
    case 'cateAgent':
      return <CateAgentSidebarView wsId={selectedWorkspaceId ?? ''} rootPath={rootPath} />
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Shared activity bar sidebar — parameterized by side
// ---------------------------------------------------------------------------

/** Width of an activity-bar rail (icon strip). Shared with MainWindowShell so
 *  it can reserve the right amount of top-left space past the macOS lights. */
export const BAR_WIDTH = 40

// dataTransfer MIME for rail-to-rail view drags. Native HTML5 DnD is used here
// (same-window, lightweight) — deliberately separate from the panel useDragStore
// system, which handles cross-window panel drags.
const DRAG_MIME = 'application/x-cate-sidebar-view'

interface ActivityBarSidebarProps {
  side: SidebarSide
  defaultWidth: number
  minWidth: number
  maxWidth: number
}

const ActivityBarSidebar: React.FC<ActivityBarSidebarProps> = ({ side, defaultWidth, minWidth, maxWidth }) => {
  const layout = useSidebarLayout()
  const views = layout[side]
  const tintOpacity = useSettingsStore((s) => s.sidebarTintOpacity)
  const activeView = useUIStore((s) => (side === 'left' ? s.activeLeftSidebarView : s.activeRightSidebarView))
  const setActiveView = useUIStore((s) =>
    side === 'left' ? s.setActiveLeftSidebarView : s.setActiveRightSidebarView,
  )
  // Either sidebar can be fully hidden (rail + content, width 0) via its top
  // toggle; reopened from the floating edge toggle in MainWindowShell. Selected
  // by side so the shared rail's toggle drives the correct one.
  const leftSidebarHidden = useUIStore((s) => s.leftSidebarHidden)
  const rightSidebarHidden = useUIStore((s) => s.rightSidebarHidden)
  const setLeftSidebarHidden = useUIStore((s) => s.setLeftSidebarHidden)
  const setRightSidebarHidden = useUIStore((s) => s.setRightSidebarHidden)
  const sidebarHidden = side === 'left' ? leftSidebarHidden : rightSidebarHidden
  const setSidebarHidden = side === 'left' ? setLeftSidebarHidden : setRightSidebarHidden

  // Rail-to-rail view drag (native HTML5 DnD). draggingView is shared across
  // both rails so each can act as a drop target for the other.
  const moveSidebarView = useUIStore((s) => s.moveSidebarView)
  const draggingView = useUIStore((s) => s.draggingView)
  const setDraggingView = useUIStore((s) => s.setDraggingView)
  const isDragActive = draggingView !== null

  // Guard: if activeView is not present on this side (e.g. layout changed), clear it
  useEffect(() => {
    if (activeView !== null && !views.includes(activeView)) {
      setActiveView(null)
    }
  }, [activeView, views, setActiveView])

  const isExpanded = activeView !== null
  const isEmpty = views.length === 0

  // macOS: the traffic-light island (MacWindowChrome) floats over the top-left,
  // so the left sidebar insets its content below it while its surface fills to
  // y=0 (seamless behind the lights). The toggle lives in this strip in both
  // windowed and fullscreen (only the lights disappear in fullscreen), so the
  // inset is unconditional on the left. Only the left side sits under it.
  const macChromeInset = side === 'left' && IS_MAC ? MAC_CHROME_HEIGHT : 0

  const [width, setWidth] = useState(defaultWidth)
  const [isResizing, setIsResizing] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  // When a rail is empty it collapses to 0. During a view drag, reveal it as a
  // drop target when the cursor enters this side's half of the window, so a user
  // can move every view off a rail and still drop back onto it.
  const [dragRevealed, setDragRevealed] = useState(false)
  useEffect(() => {
    if (!isDragActive || !isEmpty) {
      setDragRevealed(false)
      return
    }
    const onDragOver = (e: DragEvent) => {
      const half = window.innerWidth / 2
      setDragRevealed(side === 'left' ? e.clientX < half : e.clientX >= half)
    }
    window.addEventListener('dragover', onDragOver)
    return () => window.removeEventListener('dragover', onDragOver)
  }, [isDragActive, isEmpty, side])

  // Drop indicator: the index where a drop would land among this rail's icons.
  // Mirrored in a ref because the drop handler needs the freshest value (dragOver
  // state updates may not have flushed, and dragLeave can clear it just before
  // drop fires).
  const [dropIndicator, setDropIndicatorState] = useState<number | null>(null)
  const dropIndicatorRef = useRef<number | null>(null)
  const setDropIndicator = useCallback((value: number | null) => {
    dropIndicatorRef.current = value
    setDropIndicatorState(value)
  }, [])
  const iconsContainerRef = useRef<HTMLDivElement | null>(null)

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

  // --- Drag handlers (rail-to-rail view DnD) ---

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

  // Index (0..views.length) where a drop at clientY would insert, from each
  // icon's mid-height.
  const computeDropIndex = (clientY: number): number => {
    const container = iconsContainerRef.current
    if (!container) return views.length
    const buttons = Array.from(container.querySelectorAll<HTMLElement>('[data-sidebar-icon]'))
    for (let i = 0; i < buttons.length; i++) {
      const rect = buttons[i].getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) return i
    }
    return buttons.length
  }

  const handleBarDragOver = (e: React.DragEvent) => {
    if (!isDragActive) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDropIndicator(computeDropIndex(e.clientY))
  }

  const handleBarDragLeave = (e: React.DragEvent) => {
    // Only clear when the cursor leaves the bar entirely (not on inner moves).
    const related = e.relatedTarget as Node | null
    if (!related || !(e.currentTarget as HTMLElement).contains(related)) {
      setDropIndicator(null)
    }
  }

  const handleBarDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const view = ((e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain')) as SidebarView) || draggingView
    // Recompute from the cursor — the indicator ref can be cleared by a stray
    // dragLeave immediately before drop fires.
    const targetIndex = computeDropIndex(e.clientY)
    setDropIndicator(null)
    setDraggingView(null)
    if (view) moveSidebarView(view, side, targetIndex)
  }

  // --- Render ---

  // Drop-indicator line shown between icons during a view drag.
  const dropLine = (
    <div className="w-6 h-[2px] my-0.5 bg-blue-400 rounded-full pointer-events-none" />
  )

  const bar = (
    <div
      className="flex-shrink-0 flex flex-col items-center h-full relative"
      style={{
        width: BAR_WIDTH,
        backgroundColor: isExpanded
          ? 'color-mix(in srgb, var(--surface-0) 60%, transparent)'
          : undefined,
      }}
      onDragOver={handleBarDragOver}
      onDragLeave={handleBarDragLeave}
      onDrop={handleBarDrop}
    >
      {/* Collapse toggle — its own 36px header so it centers on the same line
          as the canvas tab bar's +/split buttons, then fully hides this
          sidebar. Reopened from the floating edge toggle in MainWindowShell.
          The icon points toward the window edge it collapses to. */}
      <div className="flex items-center justify-center w-full flex-shrink-0" style={{ height: 36 }}>
        <Tooltip label="Hide sidebar" placement={side === 'left' ? 'right' : 'left'}>
          <button
            type="button"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-muted hover:text-secondary hover:bg-hover transition-colors"
            onClick={() => setSidebarHidden(true)}
            aria-label="Hide sidebar"
          >
            <SidebarSimple
              size={16}
              className="pointer-events-none"
              style={side === 'right' ? { transform: 'scaleX(-1)' } : undefined}
            />
          </button>
        </Tooltip>
      </div>
      <div ref={iconsContainerRef} className="flex flex-col items-center w-full relative">
        {views.map((view, index) => {
          const meta = VIEW_META[view]
          const Icon = meta.icon
          const isActive = activeView === view
          const showBefore = isDragActive && dropIndicator === index
          const showAfter =
            isDragActive && index === views.length - 1 && dropIndicator === views.length
          return (
            <React.Fragment key={view}>
              {showBefore && dropLine}
              <div className="relative w-full flex items-center justify-center">
                <div
                  role="button"
                  tabIndex={0}
                  data-sidebar-icon=""
                  draggable
                  onDragStart={(e) => handleIconDragStart(e, view)}
                  onDragEnd={handleIconDragEnd}
                  className={`relative flex items-center justify-center w-8 h-8 my-1 rounded-lg transition-colors cursor-pointer ${
                    isActive ? 'text-primary' : 'text-muted hover:text-secondary'
                  }`}
                  onClick={() => handleIconClick(view)}
                  title={isActive ? `${meta.title}. Click to collapse.` : meta.title}
                >
                  <Icon size={16} className="pointer-events-none" />
                </div>
              </div>
              {showAfter && dropLine}
            </React.Fragment>
          )
        })}
        {/* Empty-rail drop target (revealed during a drag). */}
        {isDragActive && views.length === 0 && dropIndicator !== null && dropLine}
      </div>
      {side === 'right' && (
        <div className="mt-auto flex flex-col items-center pb-1 w-full">
          {/* The standalone ⌘K search icon was removed now that the dedicated
              Search view exists; ⌘K still opens the command palette via keyboard. */}
          <Tooltip label="Skills" placement="left">
            <button
              type="button"
              className="flex items-center justify-center w-8 h-8 my-1 rounded-lg text-muted hover:text-secondary transition-colors"
              onClick={() => useUIStore.getState().setShowSkillsDialog(true)}
              aria-label="Skills"
            >
              <PuzzlePiece size={16} className="pointer-events-none" />
            </button>
          </Tooltip>
          <Tooltip label="Saved Layouts" placement="left">
            <button
              type="button"
              className="flex items-center justify-center w-8 h-8 my-1 rounded-lg text-muted hover:text-secondary transition-colors"
              onClick={() => useUIStore.getState().setShowLayoutsDialog(true)}
              aria-label="Saved Layouts"
            >
              <FloppyDisk size={16} className="pointer-events-none" />
            </button>
          </Tooltip>
          <Tooltip label="Settings" placement="left">
            <button
              type="button"
              className="flex items-center justify-center w-8 h-8 my-1 rounded-lg text-muted hover:text-secondary transition-colors"
              onClick={() => useUIStore.getState().openSettings()}
              aria-label="Settings"
            >
              <Gear size={16} className="pointer-events-none" />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  )

  const content = (
    <div
      className={`flex-1 min-w-0 flex flex-col h-full overflow-hidden transition-opacity duration-200 relative ${
        isExpanded ? 'opacity-100' : 'opacity-0 pointer-events-none'
      } ${
        // Left sidebar's vertical scrollbar is on its right edge — exactly where
        // the 6px resize handle sits. Inset the content by the handle width so
        // the scrollbar clears it and stays draggable. (The right sidebar's
        // scrollbar is next to its activity bar, away from its handle.)
        side === 'left' ? 'pr-1' : ''
      }`}
    >
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {activeView && (
          <div key={activeView} className="absolute inset-0 animate-sidebar-view-in">
            <SidebarViewContent view={activeView} rootPath={rootPath} />
          </div>
        )}
      </div>
      {/* Version marker — shown on whichever side hosts the workspaces view */}
      {isExpanded && activeView === 'workspaces' && (
        <div className="flex-shrink-0 px-2 pt-1.5 pb-4 flex items-center justify-center gap-1.5 select-none">
          <svg viewBox="0 0 389 204" className="h-3 w-auto text-secondary" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-label="Cate">
            <path d="M274 203.2L307.29 1.79999H388.29L384.51 24.84H329.97L320.5 80.16H342.22H366.34L362.74 103.2H338.62H316.5L304.06 180.16H358.6L355 203.2H314.5H274Z" />
            <path d="M201.264 203.2L230.424 26.5H197.124L201.264 1.3H294.864L290.724 26.5H257.424L228.264 203.2H201.264Z" />
            <path d="M89 133.2L142.1 1.79999H176.3L188 133.2H161.18L159.56 103.5H128.24L117.26 133.2H89ZM136.16 81.9H158.3L157.04 50.22C156.92 45.66 156.68 41.16 156.32 36.72C156.08 32.16 155.9 28.62 155.78 26.1C154.94 28.62 153.8 32.1 152.36 36.54C151.04 40.98 149.54 45.48 147.86 50.04L136.16 81.9Z" />
            <path d="M38.1825 135C29.4225 135 21.9825 133.38 15.8625 130.14C9.7425 126.78 5.3625 122.16 2.7225 116.28C0.0824997 110.28 -0.6375 103.32 0.5625 95.4L9.3825 39.6C10.7025 31.56 13.6425 24.6 18.2025 18.72C22.7625 12.84 28.5825 8.27999 35.6625 5.04C42.8625 1.68 50.8425 0 59.6025 0C68.4825 0 75.9225 1.68 81.9225 5.04C87.9225 8.27999 92.3025 12.84 95.0625 18.72C97.8225 24.6 98.5425 31.56 97.2225 39.6H70.2225C71.1825 34.32 70.4025 30.3 67.8825 27.54C65.3625 24.78 61.4025 23.4 56.0025 23.4C50.6025 23.4 46.2225 24.78 42.8625 27.54C39.5025 30.3 37.3425 34.32 36.3825 39.6L27.5625 95.4C26.7225 100.56 27.5625 104.58 30.0825 107.46C32.6025 110.22 36.5625 111.6 41.9625 111.6C47.3625 111.6 51.7425 110.22 55.1025 107.46C58.4625 104.58 60.5625 100.56 61.4025 95.4H88.4025C87.2025 103.32 84.2625 110.28 79.5825 116.28C75.0225 122.16 69.2025 126.78 62.1225 130.14C55.0425 133.38 47.0625 135 38.1825 135Z" />
          </svg>
          <span className="text-[10px] text-muted">v{pkg.version}</span>
        </div>
      )}
    </div>
  )

  // Both rails share the three-state model: fully hidden (0), rail-only
  // (BAR_WIDTH), or opened (BAR_WIDTH + content width). An empty rail collapses
  // to 0 unless a drag revealed it as a drop target. The right rail also hosts
  // the skills/layouts/settings actions; the left does not.
  const sidebarWidth =
    sidebarHidden || (isEmpty && !dragRevealed)
      ? 0
      : isExpanded
        ? BAR_WIDTH + width
        : BAR_WIDTH

  return (
    <div
      data-sidebar-scrollarea
      className={`flex-shrink-0 relative flex flex-row h-full select-none overflow-hidden ${
        isResizing ? '' : 'transition-[width] duration-200 ease-in-out'
      } ${
        // Hairline seam on each rail's canvas-facing edge (right rail's left
        // edge, left rail's right edge). Omitted at 0 width so no stray 1px
        // line shows when collapsed.
        sidebarWidth === 0
          ? ''
          : side === 'right'
            ? 'border-l border-subtle'
            : 'border-r border-subtle'
      }`}
      style={{
        width: sidebarWidth,
        // macOS: reserve the traffic-light island's height at the top so the
        // sidebar's surface fills to y=0 (seamless behind the lights) while its
        // content starts below them. box-sizing keeps the fill under the padding.
        paddingTop: macChromeInset,
        // Static translucent fill — no backdrop-filter. A live blur forces the
        // compositor to re-sample everything behind the sidebar on every frame
        // that anything underneath changes (a major sustained WindowServer cost
        // given the canvas/terminals behind it). A near-opaque tint reads as the
        // same frosted surface without the per-frame compositing. The fill
        // percentage is the user's "Background opacity" sidebar setting.
        // Right sidebar blends into the canvas (canvas-bg); left stays brighter
        // (surface-1). Both respect the user's "Background opacity" setting.
        backgroundColor: `color-mix(in srgb, var(${side === 'right' ? '--canvas-bg' : '--surface-1'}) ${Math.round(tintOpacity * 100)}%, transparent)`,
      }}
    >
      {/* Opaque top strip — matches the dock tab bar height (36px) so the
          sidebar chrome lines up with the canvas tab bar. On the macOS left
          sidebar this band is the traffic-light inset (macChromeInset): nothing
          interactive sits under it (the rail/content start below the inset), so
          make it a window-drag region — otherwise the strip beside the traffic
          lights is a dead zone you can't drag the window by. Elsewhere it stays
          inert (pointer-events-none). */}
      <div
        className={`absolute top-0 left-0 right-0 h-9 ${macChromeInset > 0 ? '' : 'pointer-events-none'}`}
        style={{
          backgroundColor: side === 'right' ? 'var(--canvas-bg)' : 'var(--surface-1)',
          ...(macChromeInset > 0 ? { WebkitAppRegion: 'drag' } : {}),
        } as React.CSSProperties}
      />
      {/* Rail hugs the window edge (left rail on the left, right rail on the
          right); content sits on the canvas-facing side of each. */}
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
          className={`absolute top-0 ${side === 'left' ? 'right-0' : 'left-0'} w-[4px] h-full cursor-col-resize z-10 ${
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
