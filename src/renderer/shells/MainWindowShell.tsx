// =============================================================================
// MainWindowShell — full app shell wrapping dock zones (left, right, bottom,
// center). The center zone is a regular dock zone that holds canvas panels
// by default but can contain any panel type via splits/tabs.
// =============================================================================

import React, { useCallback, useEffect, useRef } from 'react'
import { useDockStoreContext, useDockStoreApi } from '../stores/DockStoreContext'
import { useSelectedWorkspace } from '../stores/appStore'
import type { DockZonePosition } from '../../shared/types'
import DockZone from '../docking/DockZone'
import DockResizeHandle from '../docking/DockResizeHandle'
import {
  registerDropZone,
  useDragStore,
  DockZoneDropIndicator,
  DragOverlay,
} from '../drag'
import { useUIStore } from '../stores/uiStore'
import { IS_MAC } from '../lib/platform'
import { useWindowFullscreen } from '../lib/useWindowFullscreen'
import { MAC_CHROME_WIDTH, MAC_CHROME_WIDTH_FS, TRAFFIC_LIGHTS_WIDTH } from './MacWindowChrome'
import { BAR_WIDTH } from '../sidebar/Sidebar'
import { SidebarSimple } from '@phosphor-icons/react'
import { Tooltip } from '../ui/Tooltip'

interface MainWindowShellProps {
  renderPanel: (panelId: string) => React.ReactNode
  getPanelTitle: (panelId: string) => string
  onClosePanel?: (panelId: string) => void
}

/** Width/height of the edge drop zone strips */
const EDGE_ZONE_SIZE = 60

/** Horizontal space reserved at the center tab bar's right end for the floating
 *  reopen toggle shown when the right sidebar is fully hidden. */
const RIGHT_CHROME_WIDTH = 40

/** Left inset for the floating left-reopen toggle when not clearing the macOS
 *  lights (fullscreen / non-macOS) — a small edge hug. */
const LEFT_TOGGLE_EDGE_PAD = 8

export default function MainWindowShell({
  renderPanel,
  getPanelTitle,
  onClosePanel,
}: MainWindowShellProps) {
  // macOS: reserve room at the top-left so the leftmost dock tab bar clears the
  // traffic-light island. How much depends on the left sidebar's state:
  //   • fully hidden → clear the lights + the floating reopen toggle,
  //   • rail-only    → the 40px rail already covers the left of the lights, so
  //                    only the remainder needs clearing,
  //   • opened       → the sidebar holds the space; no reserve.
  // In fullscreen the lights are gone, so only the hidden state (with its
  // floating toggle) needs a small reserve. Nested canvas-node bars are exempt.
  const leftSidebarHidden = useUIStore((s) => s.leftSidebarHidden)
  const leftSidebarOpen = useUIStore((s) => s.activeLeftSidebarView !== null)
  const setLeftSidebarHidden = useUIStore((s) => s.setLeftSidebarHidden)
  const isFullscreen = useWindowFullscreen()
  let leftReserve = 0
  if (IS_MAC) {
    if (leftSidebarHidden) leftReserve = isFullscreen ? MAC_CHROME_WIDTH_FS : MAC_CHROME_WIDTH
    else if (!leftSidebarOpen && !isFullscreen) leftReserve = Math.max(0, TRAFFIC_LIGHTS_WIDTH - BAR_WIDTH)
  }

  // Right sidebar fully hidden → float a reopen toggle at the top-right, next to
  // the center tab bar's split button (mirrors the top-left sidebar toggle).
  const rightSidebarHidden = useUIStore((s) => s.rightSidebarHidden)

  const leftVisible = useDockStoreContext((s) => s.zones.left.visible)
  const rightVisible = useDockStoreContext((s) => s.zones.right.visible)
  const bottomVisible = useDockStoreContext((s) => s.zones.bottom.visible)
  const setZoneSize = useDockStoreContext((s) => s.setZoneSize)
  const dockStoreApi = useDockStoreApi()
  const isDragging = useDragStore((s) => s.isDragging)
  const activeDropTarget = useDragStore((s) => s.target)

  // Ref for the shell container — used to compute edge drop zone rects
  const shellRef = useRef<HTMLDivElement>(null)

  // Register edge drop zones for hidden side dock areas.
  // Uses computed rects from the shell container so hit-testing works even
  // before the indicator divs render (they only render during dock drags).
  useEffect(() => {
    const cleanups: (() => void)[] = []

    if (!leftVisible) {
      cleanups.push(
        registerDropZone({
          id: 'zone-left-edge',
          zone: 'left',
          getRect: () => {
            const shell = shellRef.current
            if (!shell) return null
            const b = shell.getBoundingClientRect()
            return new DOMRect(b.left, b.top, EDGE_ZONE_SIZE, b.height)
          },
        }),
      )
    }
    if (!rightVisible) {
      cleanups.push(
        registerDropZone({
          id: 'zone-right-edge',
          zone: 'right',
          getRect: () => {
            const shell = shellRef.current
            if (!shell) return null
            const b = shell.getBoundingClientRect()
            return new DOMRect(b.right - EDGE_ZONE_SIZE, b.top, EDGE_ZONE_SIZE, b.height)
          },
        }),
      )
    }
    if (!bottomVisible) {
      cleanups.push(
        registerDropZone({
          id: 'zone-bottom-edge',
          zone: 'bottom',
          getRect: () => {
            const shell = shellRef.current
            if (!shell) return null
            const b = shell.getBoundingClientRect()
            return new DOMRect(b.left, b.bottom - EDGE_ZONE_SIZE, b.width, EDGE_ZONE_SIZE)
          },
        }),
      )
    }

    return () => cleanups.forEach((fn) => fn())
  }, [leftVisible, rightVisible, bottomVisible])

  const handleZoneResize = useCallback(
    (position: DockZonePosition, delta: number) => {
      const zone = dockStoreApi.getState().zones[position]
      const sign = position === 'left' ? 1 : -1
      setZoneSize(position, zone.size + delta * sign)
    },
    [setZoneSize],
  )

  // Edge drop indicators — shown when the matching side dock zone is hidden.
  // Each entry maps an edge zone to its visibility gate and indicator position.
  const edgeIndicators: {
    zone: 'left' | 'right' | 'bottom'
    hidden: boolean
    style: React.CSSProperties
  }[] = [
    { zone: 'left', hidden: !leftVisible, style: { top: 0, left: 0, bottom: 0, width: EDGE_ZONE_SIZE } },
    { zone: 'right', hidden: !rightVisible, style: { top: 0, right: 0, bottom: 0, width: EDGE_ZONE_SIZE } },
    { zone: 'bottom', hidden: !bottomVisible, style: { left: 0, right: 0, bottom: 0, height: EDGE_ZONE_SIZE } },
  ]

  const workspaceAccent = useSelectedWorkspace()?.color || undefined

  return (
    <div
      ref={shellRef}
      className="main-window-shell-root flex flex-col h-full w-full min-h-0 min-w-0 relative"
      style={workspaceAccent ? ({ ['--workspace-accent' as string]: workspaceAccent } as React.CSSProperties) : undefined}
    >
      {/* macOS: indent the top-level dock tab bar so its first tab clears the
          traffic-light island (amount scales with the left sidebar state).
          Nested canvas-node tab bars ([data-node-id]) are exempt. */}
      {leftReserve > 0 && (
        <style>{`
          .main-window-shell-root .dock-tab-bar { padding-left: ${leftReserve}px; }
          .main-window-shell-root [data-node-id] .dock-tab-bar { padding-left: 0; }
        `}</style>
      )}
      {/* Right sidebar hidden: reserve room at the center tab bar's right end so
          its split button clears the floating reopen toggle (below). Nested
          canvas-node tab bars ([data-node-id]) are exempt. */}
      {rightSidebarHidden && (
        <style>{`
          .main-window-shell-root [data-dock-zone="center"] .dock-tab-bar { padding-right: ${RIGHT_CHROME_WIDTH}px; }
          .main-window-shell-root [data-dock-zone="center"] [data-node-id] .dock-tab-bar { padding-right: 0; }
        `}</style>
      )}
      {/* Floating reopen toggle — pinned top-right, next to the split button,
          mirroring the top-left sidebar toggle. Only while fully hidden. */}
      {rightSidebarHidden && (
        <div
          className="absolute top-0 right-0 z-40 flex items-center justify-end select-none"
          style={{ height: 36, width: RIGHT_CHROME_WIDTH, paddingRight: 6 }}
        >
          <Tooltip label="Show sidebar" placement="bottom">
            <button
              type="button"
              aria-label="Show sidebar"
              onClick={() => useUIStore.getState().setRightSidebarHidden(false)}
              className="flex items-center justify-center w-7 h-7 rounded-[10px] text-muted hover:text-primary hover:bg-hover transition-colors"
            >
              <SidebarSimple size={16} style={{ transform: 'scaleX(-1)' }} />
            </button>
          </Tooltip>
        </div>
      )}
      {/* Left sidebar fully hidden → float a reopen toggle at the top-left, past
          the macOS traffic lights (mirrors the right reopen toggle). Marked
          no-drag so it stays clickable over the window drag island. */}
      {leftSidebarHidden && (
        <div
          className="absolute top-0 left-0 z-40 flex items-center select-none"
          style={{
            height: 36,
            paddingLeft: IS_MAC && !isFullscreen ? TRAFFIC_LIGHTS_WIDTH : LEFT_TOGGLE_EDGE_PAD,
            WebkitAppRegion: 'no-drag',
          } as React.CSSProperties}
        >
          <Tooltip label="Show sidebar" placement="bottom">
            <button
              type="button"
              aria-label="Show sidebar"
              onClick={() => setLeftSidebarHidden(false)}
              className="flex items-center justify-center w-7 h-7 rounded-[10px] text-muted hover:text-primary hover:bg-hover transition-colors"
            >
              <SidebarSimple size={16} />
            </button>
          </Tooltip>
        </div>
      )}
      {/* Top row: left dock | center dock | right dock */}
      <div className="flex flex-1 min-h-0 min-w-0">
        {/* Left dock zone */}
        {leftVisible && (
          <>
            <DockZone
              position="left"
              renderPanel={renderPanel}
              getPanelTitle={getPanelTitle}
              onClosePanel={onClosePanel}
            />
            <DockResizeHandle
              direction="horizontal"
              onResize={(delta) => handleZoneResize('left', delta)}
            />
          </>
        )}

        {/* Center dock zone — always visible, flex-1 */}
        <div className="flex-1 min-h-0 min-w-0 relative overflow-hidden">
          <DockZone
            position="center"
            renderPanel={renderPanel}
            getPanelTitle={getPanelTitle}
            onClosePanel={onClosePanel}
          />
        </div>

        {/* Right dock zone */}
        {rightVisible && (
          <>
            <DockResizeHandle
              direction="horizontal"
              onResize={(delta) => handleZoneResize('right', delta)}
            />
            <DockZone
              position="right"
              renderPanel={renderPanel}
              getPanelTitle={getPanelTitle}
              onClosePanel={onClosePanel}
            />
          </>
        )}
      </div>

      {/* Bottom dock zone */}
      {bottomVisible && (
        <>
          <DockResizeHandle
            direction="vertical"
            onResize={(delta) => handleZoneResize('bottom', delta)}
          />
          <DockZone
            position="bottom"
            renderPanel={renderPanel}
            getPanelTitle={getPanelTitle}
            onClosePanel={onClosePanel}
          />
        </>
      )}

      {/* Dock zone edge drop indicators — shown when side dock zones are hidden */}
      {isDragging &&
        edgeIndicators.map(({ zone, hidden, style }) =>
          hidden ? (
            <div
              key={zone}
              style={{
                position: 'absolute',
                ...style,
                zIndex: 9998,
                pointerEvents: 'none',
              }}
            >
              <DockZoneDropIndicator
                position={zone}
                isActive={
                  isDragging &&
                  activeDropTarget?.kind === 'dock-zone' &&
                  activeDropTarget.zone === zone
                }
              />
            </div>
          ) : null,
        )}
      <DragOverlay />
    </div>
  )
}
