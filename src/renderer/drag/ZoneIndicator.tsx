// =============================================================================
// DockZoneDropIndicator — edge-strip affordance for hidden side dock zones.
// Re-exported from drag/index.ts so call sites import via the barrel.
// =============================================================================

import React from 'react'
import { useDragStore } from './store'

interface DockZoneDropIndicatorProps {
  position: 'left' | 'right' | 'bottom'
  isActive: boolean
}

export function DockZoneDropIndicator({ position, isActive }: DockZoneDropIndicatorProps) {
  const isDragging = useDragStore((s) => s.isDragging)

  if (!isDragging || !isActive) return null

  const style: React.CSSProperties = {
    position: 'absolute',
    zIndex: 9999,
    pointerEvents: 'none',
    transition: 'all 150ms ease',
  }

  switch (position) {
    case 'left':
      Object.assign(style, {
        top: 0,
        left: 0,
        bottom: 0,
        width: 240,
        backgroundColor: 'rgba(74, 158, 255, 0.15)',
        borderRight: '2px solid rgba(74, 158, 255, 0.6)',
      })
      break
    case 'right':
      Object.assign(style, {
        top: 0,
        right: 0,
        bottom: 0,
        width: 240,
        backgroundColor: 'rgba(74, 158, 255, 0.15)',
        borderLeft: '2px solid rgba(74, 158, 255, 0.6)',
      })
      break
    case 'bottom':
      Object.assign(style, {
        left: 0,
        right: 0,
        bottom: 0,
        height: 180,
        backgroundColor: 'rgba(74, 158, 255, 0.15)',
        borderTop: '2px solid rgba(74, 158, 255, 0.6)',
      })
      break
  }

  return <div style={style} />
}

export default DockZoneDropIndicator
