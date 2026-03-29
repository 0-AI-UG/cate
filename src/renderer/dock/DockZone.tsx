// =============================================================================
// DockZone — container for a docked panel zone (left, right, or bottom).
// =============================================================================

import React, { useCallback, useRef } from 'react'
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react'
import { useDockStore } from '../stores/dockStore'
import { DockTabBar } from './DockTabBar'
import type { DockZonePosition } from '../../shared/types'
import { DOCK_ZONE_DEFAULTS } from '../../shared/types'

// -----------------------------------------------------------------------------
// Props
// -----------------------------------------------------------------------------

interface DockZoneProps {
  position: DockZonePosition
  renderPanelContent: (panelId: string, nodeId: string, zoomLevel: number) => React.ReactNode
}

// -----------------------------------------------------------------------------
// DockZone
// -----------------------------------------------------------------------------

export const DockZone = React.memo(({ position, renderPanelContent }: DockZoneProps) => {
  const zone = useDockStore((s) => s.zones[position])
  const setActiveTab = useDockStore((s) => s.setActiveTab)
  const toggleCollapse = useDockStore((s) => s.toggleZoneCollapse)
  const undockPanel = useDockStore((s) => s.undockPanel)
  const resizeZone = useDockStore((s) => s.resizeZone)

  // Resize drag state
  const rafId = useRef<number>(0)
  const pendingSize = useRef<number | null>(null)
  const dragStart = useRef<{ clientPos: number; startSize: number } | null>(null)

  // -------------------------------------------------------------------------
  // Resize handle mouse handling
  // -------------------------------------------------------------------------

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const isHorizontal = position === 'bottom'
      const startPos = isHorizontal ? e.clientY : e.clientX
      dragStart.current = { clientPos: startPos, startSize: zone.size }

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!dragStart.current) return
        const currentPos = isHorizontal ? moveEvent.clientY : moveEvent.clientX
        const delta = dragStart.current.clientPos - currentPos

        let newSize: number
        if (position === 'left') {
          newSize = dragStart.current.startSize + (currentPos - dragStart.current.clientPos)
        } else if (position === 'right') {
          newSize = dragStart.current.startSize + delta
        } else {
          // bottom
          newSize = dragStart.current.startSize + delta
        }

        const { minSize } = DOCK_ZONE_DEFAULTS[position]
        pendingSize.current = Math.max(minSize, newSize)

        if (rafId.current) cancelAnimationFrame(rafId.current)
        rafId.current = requestAnimationFrame(() => {
          if (pendingSize.current !== null) {
            resizeZone(position, pendingSize.current)
            pendingSize.current = null
          }
        })
      }

      const onMouseUp = () => {
        dragStart.current = null
        if (rafId.current) {
          cancelAnimationFrame(rafId.current)
          rafId.current = 0
        }
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.body.style.cursor = isHorizontal ? 'ns-resize' : 'ew-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    },
    [position, zone.size, resizeZone],
  )

  // -------------------------------------------------------------------------
  // Tab callbacks
  // -------------------------------------------------------------------------

  const handleTabClick = useCallback(
    (index: number) => {
      setActiveTab(position, index)
    },
    [position, setActiveTab],
  )

  const handleTabClose = useCallback(
    (panelId: string) => {
      undockPanel(panelId)
    },
    [undockPanel],
  )

  // -------------------------------------------------------------------------
  // Empty zone — render nothing
  // -------------------------------------------------------------------------

  if (zone.panelIds.length === 0) return null

  // -------------------------------------------------------------------------
  // Collapsed state — thin strip with toggle button
  // -------------------------------------------------------------------------

  if (zone.collapsed) {
    const isVertical = position === 'left' || position === 'right'
    const collapseButtonIcon = (() => {
      if (position === 'left') return <ChevronRight size={14} className="text-white/60" />
      if (position === 'right') return <ChevronLeft size={14} className="text-white/60" />
      return <ChevronUp size={14} className="text-white/60" />
    })()

    const stripStyle: React.CSSProperties = isVertical
      ? { width: 32, flexShrink: 0 }
      : { height: 32, flexShrink: 0 }

    const borderClass =
      position === 'left'
        ? 'border-r border-white/[0.08]'
        : position === 'right'
        ? 'border-l border-white/[0.08]'
        : 'border-t border-white/[0.08]'

    return (
      <div
        className={`bg-[#1e1e1e] ${borderClass} flex items-center justify-center`}
        style={stripStyle}
      >
        <button
          onClick={() => toggleCollapse(position)}
          title="Expand"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/[0.1] transition-colors duration-100"
        >
          {collapseButtonIcon}
        </button>
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // Normal state — full zone with tab bar, content, resize handle
  // -------------------------------------------------------------------------

  const isVertical = position === 'left' || position === 'right'
  const activePanelId = zone.panelIds[zone.activePanelIndex] ?? zone.panelIds[0]

  const containerStyle: React.CSSProperties = isVertical
    ? { width: zone.size, flexShrink: 0 }
    : { height: zone.size, flexShrink: 0 }

  const borderClass =
    position === 'left'
      ? 'border-r border-white/[0.08]'
      : position === 'right'
      ? 'border-l border-white/[0.08]'
      : 'border-t border-white/[0.08]'

  // Resize handle positioned on the inner edge
  const resizeHandleStyle: React.CSSProperties =
    position === 'left'
      ? { position: 'absolute', top: 0, right: 0, width: 4, height: '100%', cursor: 'ew-resize' }
      : position === 'right'
      ? { position: 'absolute', top: 0, left: 0, width: 4, height: '100%', cursor: 'ew-resize' }
      : { position: 'absolute', top: 0, left: 0, width: '100%', height: 4, cursor: 'ns-resize' }

  const collapseIcon = (() => {
    if (position === 'left') return <ChevronLeft size={12} className="text-white/40" />
    if (position === 'right') return <ChevronRight size={12} className="text-white/40" />
    return <ChevronDown size={12} className="text-white/40" />
  })()

  return (
    <div
      className={`relative flex flex-col bg-[#1e1e1e] ${borderClass} overflow-hidden`}
      style={containerStyle}
    >
      {/* Resize handle — invisible draggable edge */}
      <div
        style={resizeHandleStyle}
        onMouseDown={handleResizeMouseDown}
        className="z-10 hover:bg-blue-500/20 transition-colors duration-150"
      />

      {/* Tab bar */}
      <div className="flex items-center bg-[#28282E]">
        <div className="flex-1 overflow-hidden">
          <DockTabBar
            zone={position}
            panelIds={zone.panelIds}
            activePanelIndex={zone.activePanelIndex}
            onTabClick={handleTabClick}
            onTabClose={handleTabClose}
            orientation="horizontal"
          />
        </div>
        {/* Collapse button */}
        <button
          onClick={() => toggleCollapse(position)}
          title="Collapse"
          className="w-6 h-6 flex items-center justify-center shrink-0 hover:bg-white/[0.1] transition-colors duration-100 border-b border-white/[0.08]"
        >
          {collapseIcon}
        </button>
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-hidden">
        {activePanelId && renderPanelContent(activePanelId, '', 1)}
      </div>
    </div>
  )
})
