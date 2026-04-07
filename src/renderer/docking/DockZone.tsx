// =============================================================================
// DockZone — renders a dock zone, reading the layout tree from dockStore
// and recursively rendering splits and tab stacks.
// Registers as a drop zone for dock-aware drag-and-drop.
// =============================================================================

import React, { useCallback, useEffect, useRef } from 'react'
import { useDockStoreContext } from '../stores/DockStoreContext'
import type { DockZonePosition, DockLayoutNode, PanelState } from '../../shared/types'
import DockTabStack from './DockTabStack'
import DockSplitContainer from './DockSplitContainer'
import { registerDropZone } from '../hooks/useDockDrag'
import { useDockDragStore } from '../hooks/useDockDrag'
import DropZoneOverlay from './DropZoneOverlay'

interface DockZoneProps {
  position: DockZonePosition
  renderPanel: (panelId: string) => React.ReactNode
  getPanelTitle: (panelId: string) => string
  onClosePanel?: (panelId: string) => void
  getPanel?: (panelId: string) => PanelState | undefined
  workspaceId?: string
  onPanelRemoved?: (panelId: string) => void
}

export default function DockZone({ position, renderPanel, getPanelTitle, onClosePanel, getPanel, workspaceId, onPanelRemoved }: DockZoneProps) {
  const zone = useDockStoreContext((s) => s.zones[position])
  const zoneRef = useRef<HTMLDivElement>(null)

  const isDragging = useDockDragStore((s) => s.isDragging)
  const activeDropTarget = useDockDragStore((s) => s.activeDropTarget)

  // Register this zone as a drop target
  useEffect(() => {
    return registerDropZone({
      id: `zone-${position}`,
      zone: position,
      getRect: () => zoneRef.current?.getBoundingClientRect() ?? null,
    })
  }, [position])

  const renderNode = useCallback(
    (node: DockLayoutNode): React.ReactNode => {
      if (node.type === 'tabs') {
        return (
          <DockTabStack
            key={node.id}
            stack={node}
            zone={position}
            renderPanel={renderPanel}
            getPanelTitle={getPanelTitle}
            onClosePanel={onClosePanel}
            getPanel={getPanel}
            workspaceId={workspaceId}
            onPanelRemoved={onPanelRemoved}
          />
        )
      }
      return (
        <DockSplitContainer
          key={node.id}
          node={node}
          renderNode={renderNode}
        />
      )
    },
    [renderPanel, getPanelTitle, onClosePanel],
  )

  if (!zone.visible) return null

  // Check if this zone is the active drop target
  const isOver =
    isDragging &&
    activeDropTarget?.type === 'zone' &&
    activeDropTarget.zone === position

  // Center zone fills its parent (100%); side zones use fixed size
  const isCenter = position === 'center'
  const style: React.CSSProperties = isCenter
    ? { width: '100%', height: '100%' }
    : {
        [position === 'bottom' ? 'height' : 'width']: `${zone.size}px`,
        flexShrink: 0,
      }

  return (
    <div
      ref={zoneRef}
      className={`flex flex-col overflow-hidden relative ${isCenter ? 'bg-canvas-bg' : 'bg-[#1f1e1c]'}`}
      style={style}
    >
      {zone.layout ? renderNode(zone.layout) : (
        // Empty center zone — show background
        isCenter && <div className="w-full h-full" />
      )}
      {/* Only show zone-level overlay when zone is empty (stacks handle their own) */}
      {!zone.layout && <DropZoneOverlay activeTarget={activeDropTarget} isOver={isOver} />}
    </div>
  )
}
