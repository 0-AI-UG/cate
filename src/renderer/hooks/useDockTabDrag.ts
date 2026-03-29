// =============================================================================
// useDockTabDrag — drag hook for dock tab bar tabs.
// Supports reordering within a zone and undocking by dragging away.
// =============================================================================

import { useCallback, useRef } from 'react'
import type { DockZonePosition, PanelType } from '../../shared/types'
import { useDockStore } from '../stores/dockStore'
import { useCanvasStore } from '../stores/canvasStore'
import { useAppStore } from '../stores/appStore'

interface UseDockTabDragReturn {
  handleTabDragStart: (panelId: string, index: number, e: React.MouseEvent) => void
}

export function useDockTabDrag(zone: DockZonePosition): UseDockTabDragReturn {
  const dragState = useRef<{
    panelId: string
    startIndex: number
    startX: number
    startY: number
    isDraggingOut: boolean
  } | null>(null)

  const handleTabDragStart = useCallback((panelId: string, index: number, e: React.MouseEvent) => {
    e.preventDefault()

    dragState.current = {
      panelId,
      startIndex: index,
      startX: e.clientX,
      startY: e.clientY,
      isDraggingOut: false,
    }

    const handleMouseMove = (ev: MouseEvent) => {
      const ds = dragState.current
      if (!ds) return

      const dx = ev.clientX - ds.startX
      const dy = ev.clientY - ds.startY
      const dist = Math.hypot(dx, dy)

      // If dragged more than 40px away from start, undock to canvas
      if (dist > 40 && !ds.isDraggingOut) {
        ds.isDraggingOut = true

        // Find the panel type
        const workspace = useAppStore.getState().selectedWorkspace()
        const panel = workspace?.panels[ds.panelId]
        if (!panel) return

        // Undock from dock zone
        useDockStore.getState().undockPanel(ds.panelId)

        // Convert screen position to canvas coordinates
        const canvasStore = useCanvasStore.getState()
        const canvasPoint = canvasStore.viewToCanvas({ x: ev.clientX - 100, y: ev.clientY - 14 })

        // Create canvas node at cursor position
        canvasStore.addNode(ds.panelId, panel.type as PanelType, canvasPoint)

        // Clean up this drag
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
        dragState.current = null
      }
    }

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      dragState.current = null
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }, [zone])

  return { handleTabDragStart }
}
