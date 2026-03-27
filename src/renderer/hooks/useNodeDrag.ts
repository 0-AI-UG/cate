// =============================================================================
// useNodeDrag — drag-to-move hook for canvas nodes.
// Ported from CanvasNode.swift drag logic.
// =============================================================================

import { useCallback, useRef } from 'react'
import { useCanvasStore } from '../stores/canvasStore'
import { useSettingsStore } from '../stores/settingsStore'
import { snap } from '../canvas/layoutEngine'
import type { Point, Rect } from '../../shared/types'

interface DragState {
  lastClientX: number
  lastClientY: number
  initialOrigin: Point
}

interface UseNodeDragReturn {
  isDragging: boolean
  handleDragStart: (e: React.MouseEvent) => void
}

export function useNodeDrag(nodeId: string, zoomLevel: number): UseNodeDragReturn {
  const dragStateRef = useRef<DragState | null>(null)
  const isDraggingRef = useRef(false)

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()

      const node = useCanvasStore.getState().nodes[nodeId]
      if (!node || node.isPinned) return

      dragStateRef.current = {
        lastClientX: e.clientX,
        lastClientY: e.clientY,
        initialOrigin: { ...node.origin },
      }
      isDraggingRef.current = true

      const handleMouseMove = (ev: MouseEvent) => {
        const ds = dragStateRef.current
        if (!ds) return

        const zoom = useCanvasStore.getState().zoomLevel
        const currentNode = useCanvasStore.getState().nodes[nodeId]
        if (!currentNode) return

        const deltaX = (ev.clientX - ds.lastClientX) / zoom
        const deltaY = (ev.clientY - ds.lastClientY) / zoom

        const newOrigin: Point = {
          x: currentNode.origin.x + deltaX,
          y: currentNode.origin.y + deltaY,
        }

        ds.lastClientX = ev.clientX
        ds.lastClientY = ev.clientY

        useCanvasStore.getState().moveNode(nodeId, newOrigin)
      }

      const handleMouseUp = () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)

        isDraggingRef.current = false

        // Snap to grid if enabled
        const settings = useSettingsStore.getState()
        if (settings.snapToGridEnabled) {
          const state = useCanvasStore.getState()
          const node = state.nodes[nodeId]
          if (node) {
            const nodeRect: Rect = { origin: node.origin, size: node.size }
            const neighbors: Rect[] = Object.values(state.nodes)
              .filter((n) => n.id !== nodeId)
              .map((n) => ({ origin: n.origin, size: n.size }))

            const snappedOrigin = snap(
              nodeRect,
              neighbors,
              settings.gridSpacing,
              8,
            )
            useCanvasStore.getState().moveNode(nodeId, snappedOrigin)
          }
        }

        dragStateRef.current = null
      }

      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
    },
    [nodeId, zoomLevel],
  )

  return {
    isDragging: isDraggingRef.current,
    handleDragStart,
  }
}
