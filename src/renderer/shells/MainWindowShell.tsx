// =============================================================================
// MainWindowShell — full app shell wrapping dock zones (left, right, bottom,
// center). The center zone is a regular dock zone that holds canvas panels
// by default but can contain any panel type via splits/tabs.
// =============================================================================

import React, { useCallback, useEffect, useRef } from 'react'
import { useDockStoreContext, useDockStoreApi } from '../stores/DockStoreContext'
import type { DockZonePosition } from '../../shared/types'
import DockZone from '../docking/DockZone'
import DockResizeHandle from '../docking/DockResizeHandle'
import {
  registerDropZone,
  useDragStore,
  DockZoneDropIndicator,
  DragOverlay,
} from '../drag'

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

  // Determine if each zone edge is the active drop target
  const isLeftEdgeActive =
    isDragging &&
    activeDropTarget?.kind === 'dock-zone' &&
    activeDropTarget.zone === 'left'
  const isRightEdgeActive =
    isDragging &&
    activeDropTarget?.kind === 'dock-zone' &&
    activeDropTarget.zone === 'right'
  const isBottomEdgeActive =
    isDragging &&
    activeDropTarget?.kind === 'dock-zone' &&
    activeDropTarget.zone === 'bottom'

  return (
    <div ref={shellRef} className="flex flex-col h-full w-full min-h-0 min-w-0 relative">
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
      {isDragging && !leftVisible && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            bottom: 0,
            width: 60,
            zIndex: 9998,
            pointerEvents: 'none',
          }}
        >
          <DockZoneDropIndicator position="left" isActive={isLeftEdgeActive} />
        </div>
      )}
      {isDragging && !rightVisible && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: 60,
            zIndex: 9998,
            pointerEvents: 'none',
          }}
        >
          <DockZoneDropIndicator position="right" isActive={isRightEdgeActive} />
        </div>
      )}
      {isDragging && !bottomVisible && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 60,
            zIndex: 9998,
            pointerEvents: 'none',
          }}
        >
          <DockZoneDropIndicator position="bottom" isActive={isBottomEdgeActive} />
        </div>
      )}
      <DragOverlay />
    </div>
  )
}
