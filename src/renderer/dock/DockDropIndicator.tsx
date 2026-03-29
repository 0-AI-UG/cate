// =============================================================================
// DockDropIndicator — overlay shown when dragging a panel over a dock zone.
// =============================================================================

import React from 'react'
import { useUIStore } from '../stores/uiStore'

export function DockDropIndicator() {
  const dockDropTarget = useUIStore((s) => s.dockDropTarget)
  if (!dockDropTarget) return null

  const style: React.CSSProperties = {
    position: 'fixed',
    zIndex: 9999,
    pointerEvents: 'none',
    transition: 'opacity 150ms',
  }

  switch (dockDropTarget) {
    case 'left':
      Object.assign(style, { top: 0, left: 0, width: '300px', height: '100%' })
      break
    case 'right':
      Object.assign(style, { top: 0, right: 0, width: '350px', height: '100%' })
      break
    case 'bottom':
      Object.assign(style, { bottom: 0, left: 0, width: '100%', height: '250px' })
      break
  }

  return <div style={style} className="bg-blue-500/20 border-2 border-blue-500/50 rounded-lg" />
}
