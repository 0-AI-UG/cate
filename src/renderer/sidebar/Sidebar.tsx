import { useShortcutLabel } from '../stores/shortcutStore'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ProjectList } from './ProjectList'
import { useUIStore } from '../stores/uiStore'
import { useSettingsStore } from '../stores/settingsStore'
import { GitPullRequest, ArrowLeft, ChartNoAxesCombined, Settings as Gear, Puzzle as PuzzlePiece, PanelLeft as SidebarSimple } from 'lucide-react'
import { UpdateButton } from '../ui/UpdateButton'
import { Tooltip } from '../ui/Tooltip'
import { IS_MAC } from '../lib/platform'
import { useWindowFullscreen } from '../lib/useWindowFullscreen'
import { TRAFFIC_LIGHTS_WIDTH } from '../shells/MacWindowChrome'
import { CateLogo } from '../ui/CateLogo'

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

  const shortcutLabel = useShortcutLabel()
  const [width, setWidth] = useState(defaultWidth)
  const [isResizing, setIsResizing] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

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
              <Tooltip action="skills" label="Skills" placement="top">
                <button
                  type="button"
                  className="flex items-center justify-center w-8 h-8 rounded-lg text-muted hover:text-secondary hover:bg-hover focus-visible:outline-offset-[-2px] transition-colors"
                  onClick={() => useUIStore.getState().setShowSkillsDialog(true)}
                  aria-label="Skills"
                >
                  <PuzzlePiece size={16} className="pointer-events-none" />
                </button>
              </Tooltip>
              <Tooltip action="openRepository" label="Repository" placement="top">
                <button type="button" aria-label="Repository" onClick={() => useUIStore.getState().openRepository()} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-secondary">
                  <GitPullRequest size={16} />
                </button>
              </Tooltip>
              <Tooltip action="openUsage" label="Usage" placement="top">
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
              <Tooltip action="openSettings" label="Settings" placement="top">
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
                    title={shortcutLabel('toggleSidebar', 'Hide sidebar')}
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
            <ProjectList
              headerTitle={<CateLogo size={88} className="h-7 w-auto text-primary" aria-label="Cate" />}
              headerLeadingAction={(
                <div className="flex items-center" style={{ marginLeft: macTrafficLightsInset ? macTrafficLightsInset - 12 : 0 }}>
                  <button
                    type="button"
                    className="flex items-center justify-center w-8 h-8 rounded-lg text-muted hover:text-secondary hover:bg-hover transition-colors"
                    onClick={() => setSidebarHidden(true)}
                    aria-label="Hide sidebar"
                    title={shortcutLabel('toggleSidebar', 'Hide sidebar')}
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

  // The workspace sidebar is either hidden or full width.
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
