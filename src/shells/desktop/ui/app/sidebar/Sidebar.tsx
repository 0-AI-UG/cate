// The sidebar frame: the workspace list, and while settings are open the
// settings navigation (in `settings-sidebar-slot`); resizable, hideable, with
// the skills / repository / settings buttons and the update button at the
// bottom. Window controls (macOS traffic lights) inset its header.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, GitPullRequest, ChartNoAxesCombined, Settings as Gear, Puzzle as PuzzlePiece, PanelLeft as SidebarSimple, type LucideIcon } from 'lucide-react'
import { Tooltip, useShortcutLabel } from '../../kernel/interaction'
import { useClientSetting } from '../../kernel/settings'
import type { ActionId } from '@kernel/interaction/contract'
import { CateLogo } from '../chrome/CateLogo'
import { UpdateButton } from '../chrome/UpdateButton'
import { useWindowControlsInset } from '../chrome/chrome'
import { hasOverlay, useOverlaysVersion } from '../overlays'
import { useUIStore } from '../state/uiStore'
import { WorkspaceList } from './WorkspaceList'

export interface SidebarProps {
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
  /** Overlay views with a sidebar button, besides settings. A button shows
   *  once its view is registered (`registerOverlay`). */
  overlayButtons?: readonly SidebarOverlayButton[]
}

export interface SidebarOverlayButton {
  view: string
  label: string
  action?: ActionId
  icon: LucideIcon
}

const DEFAULT_OVERLAY_BUTTONS: readonly SidebarOverlayButton[] = [
  { view: 'skills', label: 'Skills', action: 'skills', icon: PuzzlePiece },
  { view: 'pullRequests', label: 'Repository', action: 'openRepository', icon: GitPullRequest },
  { view: 'usage', label: 'Usage', action: 'openUsage', icon: ChartNoAxesCombined },
]

export function Sidebar({ defaultWidth = 220, minWidth = 220, maxWidth = 400, overlayButtons = DEFAULT_OVERLAY_BUTTONS }: SidebarProps): JSX.Element {
  const tintOpacity = useClientSetting('sidebarTintOpacity')
  const hidden = useUIStore((s) => s.sidebarHidden)
  const overlay = useUIStore((s) => s.overlay)
  const settingsOpen = overlay?.view === 'settings'
  const controlsInset = useWindowControlsInset()
  const shortcutLabel = useShortcutLabel()
  useOverlaysVersion()
  const [width, setWidth] = useState(defaultWidth)
  const [resizing, setResizing] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  const onResizeDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setResizing(true)
    startXRef.current = e.clientX
    startWidthRef.current = width
  }, [width])

  useEffect(() => {
    if (!resizing) return
    let pendingX = startXRef.current
    let raf = 0
    const onMove = (e: MouseEvent) => {
      pendingX = e.clientX
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setWidth(Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + pendingX - startXRef.current)))
      })
    }
    const onUp = () => setResizing(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [resizing, minWidth, maxWidth])

  const hideButton = (
    <button
      type="button"
      className="flex items-center justify-center w-8 h-8 rounded-lg text-muted hover:text-secondary hover:bg-hover transition-colors"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      onClick={() => useUIStore.getState().setSidebarHidden(true)}
      aria-label="Hide sidebar"
      title={shortcutLabel('toggleSidebar', 'Hide sidebar')}
    >
      <SidebarSimple size={16} />
    </button>
  )

  const ui = useUIStore.getState
  const utilities = !settingsOpen && (
    <div className="flex-shrink-0 flex items-center gap-1 px-2 py-2">
      {overlay ? (
        <button
          type="button"
          aria-label="Back to workspace"
          onClick={() => ui().closeOverlay()}
          className="flex-1 h-8 px-2 flex items-center gap-2 rounded-md text-[13px] text-secondary hover:bg-hover hover:text-primary transition-colors"
        >
          <ArrowLeft size={16} />
          Back
        </button>
      ) : (
        <>
          {overlayButtons.filter((b) => hasOverlay(b.view)).map(({ view, label, action, icon: ButtonIcon }) => (
            <Tooltip key={view} action={action} label={label} placement="top">
              <button
                type="button"
                aria-label={label}
                onClick={() => ui().openOverlay({ view })}
                className="flex items-center justify-center w-8 h-8 rounded-lg text-muted hover:text-secondary hover:bg-hover transition-colors"
              >
                <ButtonIcon size={16} className="pointer-events-none" />
              </button>
            </Tooltip>
          ))}
          <Tooltip action="openSettings" label="Settings" placement="top">
            <button
              type="button"
              aria-label="Settings"
              aria-pressed={settingsOpen}
              onClick={() => ui().toggleSettings()}
              className="flex items-center justify-center w-8 h-8 rounded-lg text-muted hover:text-secondary hover:bg-hover transition-colors"
            >
              <Gear size={16} className="pointer-events-none" />
            </button>
          </Tooltip>
        </>
      )}
      <UpdateButton className="ml-auto" />
    </div>
  )

  const sidebarWidth = hidden ? 0 : width

  return (
    <div
      data-app-sidebar="left"
      data-sidebar-scrollarea
      className={`flex-shrink-0 relative flex flex-row h-full select-none overflow-hidden ${resizing ? '' : 'transition-[width] duration-200 ease-in-out'} ${
        sidebarWidth === 0 ? '' : 'border-r border-subtle'
      }`}
      style={{ width: sidebarWidth, backgroundColor: `color-mix(in srgb, var(--surface-1) ${Math.round(tintOpacity * 100)}%, transparent)` }}
    >
      {/* Drag strip beside the window controls. */}
      <div
        className={`absolute top-0 left-0 right-0 h-[44px] ${controlsInset > 0 ? '' : 'pointer-events-none'}`}
        style={(controlsInset > 0 ? { WebkitAppRegion: 'drag' } : {}) as React.CSSProperties}
      />
      <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden relative pr-1">
        {settingsOpen && (
          <div
            className="app-header-bar flex-shrink-0 gap-2 pr-3"
            style={{ paddingLeft: controlsInset || 12, WebkitAppRegion: 'drag' } as React.CSSProperties}
          >
            {hideButton}
            <CateLogo size={88} className="h-7 w-auto text-primary" aria-label="Cate" />
          </div>
        )}
        <div id="settings-sidebar-slot" className={settingsOpen ? 'flex flex-col flex-1 min-h-0' : 'hidden'} />
        <div className={`flex-1 min-h-0 overflow-hidden relative ${settingsOpen ? 'hidden' : ''}`}>
          <div className="absolute inset-0 animate-sidebar-view-in">
            <WorkspaceList
              headerTitle={<CateLogo size={88} className="h-7 w-auto text-primary" aria-label="Cate" />}
              headerLeadingAction={<div className="flex items-center" style={{ marginLeft: controlsInset ? controlsInset - 12 : 0 }}>{hideButton}</div>}
            />
          </div>
        </div>
        {utilities}
      </div>
      <div
        className={`absolute top-0 right-0 w-[4px] h-full cursor-col-resize z-10 ${resizing ? 'bg-blue-500/30' : ''}`}
        onMouseDown={onResizeDown}
      />
    </div>
  )
}
