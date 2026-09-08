import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ProjectList } from './ProjectList'
import { FileExplorer } from './FileExplorer'
import { SearchView } from './SearchView'
import { SourceControlView } from './SourceControlView'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { SidebarView } from '../stores/uiStore'
import { GitPullRequest, ArrowLeft, ChartNoAxesCombined, FolderOpen, Settings as Gear, Puzzle as PuzzlePiece, PanelLeft as SidebarSimple } from 'lucide-react'
import { UpdateButton } from '../ui/UpdateButton'
import { Tooltip } from '../ui/Tooltip'
import { IS_MAC } from '../lib/platform'
import { useWindowFullscreen } from '../lib/useWindowFullscreen'
import { TRAFFIC_LIGHTS_WIDTH } from '../shells/MacWindowChrome'
import { useWorktrees } from '../stores/useWorktrees'
import { selectedWorktree } from '../lib/worktreeContext'
import { WorktreeScopeSelect } from './WorktreeScopeSelect'
import { CateLogo } from '../ui/CateLogo'

// ---------------------------------------------------------------------------
// Content renderer — renders whichever view is active, regardless of side
// ---------------------------------------------------------------------------

export const SidebarViewContent: React.FC<{ view: SidebarView; rootPath: string; workspaceHeader?: React.ReactNode; workspaceLeadingAction?: React.ReactNode; workspaceId?: string }> = ({
  view,
  rootPath,
  workspaceHeader,
  workspaceLeadingAction,
  workspaceId,
}) => {
  const selectedWorkspaceId = useAppStore((s) => workspaceId ?? s.selectedWorkspaceId)
  const setWorkspaceRootPath = useAppStore((s) => s.setWorkspaceRootPath)
  const worktrees = useWorktrees(rootPath, selectedWorkspaceId ?? '')
  const navigationWorktreeId = useUIStore(
    (s) => s.navigationWorktreeByWorkspace[selectedWorkspaceId ?? ''],
  )
  const setNavigationWorktree = useUIStore((s) => s.setNavigationWorktree)
  const navigationWorktree = selectedWorktree(worktrees, navigationWorktreeId)
  const navigationRoot = navigationWorktree?.path ?? rootPath
  const navigationScope = selectedWorkspaceId ? (
    <WorktreeScopeSelect
      worktrees={worktrees}
      value={navigationWorktree?.id}
      onChange={(id) => setNavigationWorktree(selectedWorkspaceId, id)}
      title="File navigation worktree"
    />
  ) : null

  switch (view) {
    case 'workspaces':
      return <ProjectList headerTitle={workspaceHeader} headerLeadingAction={workspaceLeadingAction} />
    case 'explorer':
      return rootPath ? (
        <FileExplorer rootPath={navigationRoot} scopeControl={navigationScope} />
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
      return <SearchView rootPath={navigationRoot} workspaceId={selectedWorkspaceId} scopeControl={navigationScope} />
    case 'git':
      return <SourceControlView rootPath={rootPath} />
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Shared activity bar sidebar — parameterized by side
// ---------------------------------------------------------------------------

interface ActivityBarSidebarProps {
  defaultWidth: number
  minWidth: number
  maxWidth: number
}

const ActivityBarSidebar: React.FC<ActivityBarSidebarProps> = ({ defaultWidth, minWidth, maxWidth }) => {
  const tintOpacity = useSettingsStore((s) => s.sidebarTintOpacity)
  const sidebarHidden = useUIStore((s) => s.leftSidebarHidden)
  const setSidebarHidden = useUIStore((s) => s.setLeftSidebarHidden)
  const showSkills = useUIStore((s) => s.showSkillsDialog)
  const showPullRequests = useUIStore((s) => s.showPullRequests)
  const showUsage = useUIStore((s) => s.showUsage)
  const showSettings = useUIStore((s) => s.showSettings)
  const settingsNavigation = showSettings

  // In windowed macOS, the left header starts beside the traffic lights.
  const isFullscreen = useWindowFullscreen()
  const macTrafficLightsInset = IS_MAC && !isFullscreen ? TRAFFIC_LIGHTS_WIDTH : 0

  const [width, setWidth] = useState(defaultWidth)
  const [isResizing, setIsResizing] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

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
          const delta = pendingX - startXRef.current
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
  }, [isResizing, minWidth, maxWidth])

  const utilities = !settingsNavigation && (
        <div className="flex-shrink-0 flex items-center gap-1 px-2 py-2">
          {showUsage || showSkills || showPullRequests ? (
            <button
              type="button"
              aria-label="Back to workspace"
              onClick={() => {
                useUIStore.getState().setShowPullRequests(false)
                useUIStore.getState().setShowUsage(false)
                useUIStore.getState().setShowSkillsDialog(false)
              }}
              className="flex-1 h-8 px-2 flex items-center gap-2 rounded-md text-[13px] text-secondary hover:bg-hover hover:text-primary transition-colors"
            >
              <ArrowLeft size={16} />
              Back
            </button>
          ) : (
            <>
              {/* The standalone ⌘K search icon was removed now that the dedicated
                  Search view exists; ⌘K still opens the command palette via keyboard. */}
              <Tooltip label="Skills" placement="top">
                <button
                  type="button"
                  className="flex items-center justify-center w-8 h-8 rounded-lg text-muted hover:text-secondary hover:bg-hover focus-visible:outline-offset-[-2px] transition-colors"
                  onClick={() => useUIStore.getState().setShowSkillsDialog(true)}
                  aria-label="Skills"
                >
                  <PuzzlePiece size={16} className="pointer-events-none" />
                </button>
              </Tooltip>
              <Tooltip label="Pull requests" placement="top">
                <button type="button" aria-label="Pull requests" onClick={() => useUIStore.getState().setShowPullRequests(true)} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-secondary">
                  <GitPullRequest size={16} />
                </button>
              </Tooltip>
              <Tooltip label="Usage" placement="top">
                <button
                  type="button"
                  className={`flex items-center justify-center w-8 h-8 rounded-lg hover:bg-hover transition-colors ${showUsage ? 'bg-hover text-primary' : 'text-muted hover:text-secondary'}`}
                  onClick={() => useUIStore.getState().setShowUsage(!showUsage)}
                  aria-label="Usage"
                  aria-pressed={showUsage}
                >
                  <ChartNoAxesCombined size={16} className="pointer-events-none" />
                </button>
              </Tooltip>
              <Tooltip label="Settings" placement="top">
                <button
                  type="button"
                  className={`flex items-center justify-center w-8 h-8 rounded-lg hover:bg-hover focus-visible:outline-offset-[-2px] transition-colors ${showSettings ? 'bg-hover text-primary' : 'text-muted hover:text-secondary'}`}
                  onClick={() => {
                    const ui = useUIStore.getState()
                    if (ui.showSettings) ui.closeSettings()
                    else ui.openSettings()
                  }}
                  aria-label="Settings"
                  aria-pressed={showSettings}
                >
                  <Gear size={16} className="pointer-events-none" />
                </button>
              </Tooltip>
            </>
          )}
          <UpdateButton className="ml-auto" />
        </div>
  )

  const content = (
    <div
      className="flex-1 min-w-0 flex flex-col h-full overflow-hidden relative pr-1"
    >
      {settingsNavigation && (
        <div
          className="app-header-bar flex-shrink-0 gap-2 pr-3"
          style={{ paddingLeft: macTrafficLightsInset || 12, WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <button
            type="button"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-muted hover:text-secondary hover:bg-hover transition-colors"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onClick={() => setSidebarHidden(true)}
            aria-label="Hide sidebar"
          >
            <SidebarSimple size={16} />
          </button>
          <CateLogo size={88} className="h-7 w-auto text-primary" aria-label="Cate" />
        </div>
      )}
      {<div id="settings-sidebar-slot" className={settingsNavigation ? 'flex flex-col flex-1 min-h-0' : 'hidden'} />}
      <div className={`flex-1 min-h-0 overflow-hidden relative ${settingsNavigation ? 'hidden' : ''}`}>
        {(
          <div className="absolute inset-0 animate-sidebar-view-in">
            <SidebarViewContent
              view="workspaces"
              rootPath={rootPath}
              workspaceHeader={<CateLogo size={88} className="h-7 w-auto text-primary" aria-label="Cate" />}
              workspaceLeadingAction={(
                <div className="flex items-center" style={{ marginLeft: macTrafficLightsInset ? macTrafficLightsInset - 12 : 0 }}>
                  <button
                    type="button"
                    className="flex items-center justify-center w-8 h-8 rounded-lg text-muted hover:text-secondary hover:bg-hover transition-colors"
                    onClick={() => setSidebarHidden(true)}
                    aria-label="Hide sidebar"
                  >
                    <SidebarSimple size={16} />
                  </button>
                </div>
              )}
            />
          </div>
        )}
      </div>
      {utilities}
    </div>
  )

  // Both sidebars are either fully hidden or full width.
  const sidebarWidth = sidebarHidden ? 0 : width

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
          : 'border-r border-subtle'
      }`}
      style={{
        width: sidebarWidth,
        // macOS supplies the frosted material behind the window. A light theme
        // tint keeps it in Cate's palette; the canvas is a separate flex sibling.
        // Other platforms retain the existing static sidebar fill.
        backgroundColor: `color-mix(in srgb, var(--surface-1) ${Math.round(tintOpacity * (IS_MAC ? 30 : 100))}%, transparent)`,
      }}
    >
      {/* The top strip is a drag region beside the macOS traffic lights.
          Let the native sidebar material continue behind the window controls. */}
      <div
        className={`absolute top-0 left-0 right-0 h-[44px] ${macTrafficLightsInset > 0 ? '' : 'pointer-events-none'}`}
        style={{
          backgroundColor: IS_MAC ? 'transparent' : 'var(--surface-1)',
          ...(macTrafficLightsInset > 0 ? { WebkitAppRegion: 'drag' } : {}),
        } as React.CSSProperties}
      />
      {content}

      {/* Resize handle on the inner edge, only when expanded */}
      {(
        <div
          className={`absolute top-0 right-0 w-[4px] h-full cursor-col-resize z-10 ${
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
  <ActivityBarSidebar defaultWidth={220} minWidth={220} maxWidth={400} />
)
