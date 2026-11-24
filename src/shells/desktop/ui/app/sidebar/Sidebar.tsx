// The sidebar frame: the workspace list, and while settings are open the
// navigation of settings and What's New (in `overlay-sidebar-slot`); resizable, hideable, with
// the skills / repository / settings buttons and the update button at the
// bottom. Window controls (macOS traffic lights) inset its header.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChartNoAxesCombined, GitPullRequest, Settings as Gear, FileText, type LucideIcon } from 'lucide-react'
import { CateLogo, Tooltip, useShortcutLabel } from '../../kernel/interaction'
import { useClientSetting } from '../../kernel/settings'
import type { ActionId } from '@kernel/interaction/contract'
import { UpdateButton } from '../chrome/UpdateButton'
import { useWhatsNewPending } from '../chrome/WhatsNew'
import { SidebarToggleIcon, useWindowControlsInset } from '../chrome/chrome'
import { hasOverlay, overlayOwnsSidebar, useOverlaysVersion } from '../overlays'
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
  { view: 'pullRequests', label: 'Repository', action: 'openRepository', icon: GitPullRequest },
  { view: 'usage', label: 'Usage', action: 'openUsage', icon: ChartNoAxesCombined },
]

export function Sidebar({ defaultWidth = 280, minWidth = 220, maxWidth = 400, overlayButtons = DEFAULT_OVERLAY_BUTTONS }: SidebarProps): JSX.Element {
  const tintOpacity = useClientSetting('sidebarTintOpacity')
  const hidden = useUIStore((s) => s.sidebarHidden)
  const overlay = useUIStore((s) => s.overlay)
  const settingsOpen = overlay?.view === 'settings'
  const navOpen = overlayOwnsSidebar(overlay?.view)
  const controlsInset = useWindowControlsInset()
  const shortcutLabel = useShortcutLabel()
  const whatsNew = useWhatsNewPending()
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
      className="flex items-center justify-center w-6 h-6 rounded-md text-muted hover:text-secondary hover:bg-hover transition-colors"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      onClick={() => useUIStore.getState().setSidebarHidden(true)}
      aria-label="Hide sidebar"
      title={shortcutLabel('toggleSidebar', 'Hide sidebar')}
    >
      <SidebarToggleIcon filled={hidden} />
    </button>
  )

  const ui = useUIStore.getState
  const utilities = !navOpen && (
    <div className="absolute bottom-0 inset-x-0 z-10 flex items-center gap-1 px-2 pb-2 pt-16">
      {/* The list scrolls behind and fades out toward the top, no hard edge. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 pointer-events-none"
        style={{
          background: 'linear-gradient(to top, var(--surface-1) 0%, color-mix(in srgb, var(--surface-1) 90%, transparent) 30%, color-mix(in srgb, var(--surface-1) 55%, transparent) 55%, color-mix(in srgb, var(--surface-1) 20%, transparent) 80%, transparent 100%)',
          maskImage: 'linear-gradient(to top, black 0%, black 35%, rgba(0,0,0,0.6) 60%, rgba(0,0,0,0.2) 85%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to top, black 0%, black 35%, rgba(0,0,0,0.6) 60%, rgba(0,0,0,0.2) 85%, transparent 100%)',
        }}
      />
      {overlay ? (
        <button
          type="button"
          aria-label="Back to workspace"
          onClick={() => ui().closeOverlay()}
          className="flex-1 h-6 px-2 flex items-center gap-2 rounded-md text-[13px] text-secondary hover:bg-hover hover:text-primary transition-colors"
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
                className="flex items-center justify-center w-6 h-6 rounded-md text-muted hover:text-secondary hover:bg-hover transition-colors"
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
              className="flex items-center justify-center w-6 h-6 rounded-md text-muted hover:text-secondary hover:bg-hover transition-colors"
            >
              <Gear size={16} className="pointer-events-none" />
            </button>
          </Tooltip>
        </>
      )}
      <div className="ml-auto flex items-center gap-1">
        <Tooltip action="whatsNew" label="What's New" placement="top">
          <button
            type="button"
            aria-label="What's New"
            onClick={whatsNew.open}
            className={`flex items-center justify-center w-6 h-6 rounded-md hover:bg-hover transition-colors ${whatsNew.pending ? 'text-focus-blue' : 'text-muted hover:text-secondary'}`}
          >
            <FileText size={16} className="pointer-events-none" />
          </button>
        </Tooltip>
        <UpdateButton />
      </div>
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
        className={`absolute top-0 left-0 right-0 h-[36px] ${controlsInset > 0 ? '' : 'pointer-events-none'}`}
        style={(controlsInset > 0 ? { WebkitAppRegion: 'drag' } : {}) as React.CSSProperties}
      />
      <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden relative">
        {navOpen && (
          <div
            className="app-header-bar flex-shrink-0 gap-2.5 pr-3"
            style={{ paddingLeft: controlsInset || 8, WebkitAppRegion: 'drag' } as React.CSSProperties}
          >
            {hideButton}
            <CateLogo size={88} className="h-7 w-auto text-primary" aria-label="Cate" />
          </div>
        )}
        <div id="overlay-sidebar-slot" className={navOpen ? 'flex flex-col flex-1 min-h-0' : 'hidden'} />
        <div className={`flex-1 min-h-0 overflow-hidden relative ${navOpen ? 'hidden' : ''}`}>
          <div className="absolute inset-0 animate-sidebar-view-in">
            <WorkspaceList
              headerTitle={<CateLogo size={88} className="h-7 w-auto text-primary" aria-label="Cate" />}
              // The toggle sits where the collapsed sidebar's reopen button does.
              headerLeadingAction={<div style={{ marginLeft: (controlsInset || 8) - 12 }}>{hideButton}</div>}
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
