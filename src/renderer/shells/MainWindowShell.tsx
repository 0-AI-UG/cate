// =============================================================================
// MainWindowShell — full app shell wrapping dock zones (left, right, bottom,
// center). The center zone is a regular dock zone that holds canvas panels
// by default but can contain any panel type via splits/tabs.
// =============================================================================

import React, { useCallback, useEffect, useRef } from 'react'
import { useDockStoreContext, useDockStoreApi } from '../stores/DockStoreContext'
import { useSelectedWorkspace } from '../stores/appStore'
import { PANEL_MINIMUM_SIZES, type DockZonePosition } from '../../shared/types'
import DockZone from '../docking/DockZone'
import DockResizeHandle from '../docking/DockResizeHandle'
import {
  registerDropZone,
  useDragStore,
  DockZoneDropIndicator,
  DragOverlay,
} from '../drag'
import { LeftSidebarReopen, useLeftChromeInset } from './LeftSidebarReopen'
import { useNavigationPanels } from '../docking/useNavigationPanels'

interface MainWindowShellProps {
  renderPanel: (panelId: string) => React.ReactNode
  getPanelTitle: (panelId: string) => string
  onClosePanel?: (panelId: string) => void
}

/** Width/height of the edge drop zone strips */
const EDGE_ZONE_SIZE = 60

export default function MainWindowShell({
  renderPanel,
  getPanelTitle,
  onClosePanel,
}: MainWindowShellProps) {
  // Reserve room at the top-left so the leftmost dock tab bar's first tab clears
  // whatever floats over that corner. Two independent things can sit there:
  //   • the floating reopen toggle — rendered on EVERY platform, but only while
  //     the left sidebar is fully hidden,
  //   • the macOS traffic-light island — only on macOS, and not in fullscreen.
  // When visible, the Workspace sidebar holds this space itself.
  // Nested canvas-node bars are exempt.
  const leftReserve = useLeftChromeInset()

  useNavigationPanels()

  const leftVisible = useDockStoreContext((s) => s.zones.left.visible)
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
  }, [leftVisible, bottomVisible])

  const handleZoneResize = useCallback(
    (position: DockZonePosition, delta: number) => {
      const shell = shellRef.current
      if (!shell) return
      const zones = dockStoreApi.getState().zones
      const zone = zones[position]
      const sign = position === 'left' ? 1 : -1
      let nextSize = zone.size + delta * sign

      if (position === 'left') {
        const rightWidth = zones.right.visible ? zones.right.size : 0
        nextSize = Math.min(nextSize, shell.clientWidth - rightWidth - PANEL_MINIMUM_SIZES.canvas.width)
      } else if (position === 'bottom') {
        nextSize = Math.min(nextSize, shell.clientHeight - PANEL_MINIMUM_SIZES.canvas.height)
      }

      setZoneSize(position, nextSize)
    },
    [dockStoreApi, setZoneSize],
  )

  // Edge drop indicators — shown when the matching side dock zone is hidden.
  // Each entry maps an edge zone to its visibility gate and indicator position.
  const edgeIndicators: {
    zone: 'left' | 'right' | 'bottom'
    hidden: boolean
    style: React.CSSProperties
  }[] = [
    { zone: 'left', hidden: !leftVisible, style: { top: 0, left: 0, bottom: 0, width: EDGE_ZONE_SIZE } },
    { zone: 'bottom', hidden: !bottomVisible, style: { left: 0, right: 0, bottom: 0, height: EDGE_ZONE_SIZE } },
  ]

  const selectedWorkspace = useSelectedWorkspace()
  const workspaceAccent = selectedWorkspace?.color || undefined

  return (
    <div
      ref={shellRef}
      className="main-window-shell-root flex flex-col h-full w-full min-h-0 min-w-0 relative"
      style={workspaceAccent ? ({ ['--workspace-accent' as string]: workspaceAccent } as React.CSSProperties) : undefined}
    >
      {/* Indent the top-level dock tab bar so its first tab clears the floating
          reopen toggle (all platforms) and the macOS traffic-light island
          (amount scales with the left sidebar state — see leftReserve above).
          Nested canvas-node tab bars ([data-node-id]) are exempt. */}
      {leftReserve > 0 && (
        <style>{`
          .main-window-shell-root .dock-tab-bar { padding-left: ${leftReserve}px; }
          .main-window-shell-root [data-node-id] .dock-tab-bar { padding-left: 0; }
        `}</style>
      )}
      {/* Left sidebar fully hidden → float a reopen toggle at the top-left, past
          the macOS traffic lights (mirrors the right reopen toggle). Marked
          no-drag so it stays clickable over the window drag island. */}
      <LeftSidebarReopen />
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
