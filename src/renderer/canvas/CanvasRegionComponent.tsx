// =============================================================================
// CanvasRegionComponent — colored rectangle container for grouping panels.
// =============================================================================

import React, { useCallback, useRef } from 'react'
import type { CanvasRegion } from '../../shared/types'
import { useCanvasStore } from '../stores/canvasStore'

interface Props {
  region: CanvasRegion
  zoomLevel: number
}

const CanvasRegionComponent: React.FC<Props> = ({ region, zoomLevel }) => {
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()

    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: region.origin.x,
      originY: region.origin.y,
    }

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const zoom = useCanvasStore.getState().zoomLevel
      const dx = (ev.clientX - dragRef.current.startX) / zoom
      const dy = (ev.clientY - dragRef.current.startY) / zoom
      useCanvasStore.getState().moveRegion(region.id, {
        x: dragRef.current.originX + dx,
        y: dragRef.current.originY + dy,
      })
    }

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      dragRef.current = null
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }, [region.id, region.origin.x, region.origin.y])

  const handleDoubleClick = useCallback(() => {
    const name = window.prompt('Rename region:', region.label)
    if (name && name.trim()) {
      useCanvasStore.getState().renameRegion(region.id, name.trim())
    }
  }, [region.id, region.label])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (confirm(`Delete region "${region.label}"?`)) {
      useCanvasStore.getState().removeRegion(region.id)
    }
  }, [region.id, region.label])

  return (
    <div
      style={{
        position: 'absolute',
        left: region.origin.x,
        top: region.origin.y,
        width: region.size.width,
        height: region.size.height,
        backgroundColor: region.color,
        borderRadius: 12,
        border: '1.5px dashed rgba(255,255,255,0.15)',
        zIndex: region.zOrder,
        cursor: 'grab',
      }}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      <div style={{
        position: 'absolute',
        top: -24,
        left: 8,
        fontSize: 12,
        fontWeight: 600,
        color: 'rgba(255,255,255,0.5)',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        pointerEvents: 'none',
      }}>
        {region.label}
      </div>
    </div>
  )
}

export default React.memo(CanvasRegionComponent)
