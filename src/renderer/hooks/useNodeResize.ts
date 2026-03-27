// =============================================================================
// useNodeResize — edge/corner resize hook for canvas nodes.
// Ported from CanvasNode.swift lines ~495-598 resize logic.
// =============================================================================

import { useCallback, useRef } from 'react'
import { useCanvasStore } from '../stores/canvasStore'
import { useSettingsStore } from '../stores/settingsStore'
import { minimumSize, snap } from '../canvas/layoutEngine'
import type { PanelType, Point, Size, Rect } from '../../shared/types'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type ResizeEdge =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'topLeft'
  | 'topRight'
  | 'bottomLeft'
  | 'bottomRight'

interface ResizeState {
  edge: ResizeEdge
  startClientX: number
  startClientY: number
  startOrigin: Point
  startSize: Size
}

interface UseNodeResizeReturn {
  isResizing: boolean
  resizeEdge: ResizeEdge | null
  handleResizeStart: (e: React.MouseEvent, edge: ResizeEdge) => void
  getCursor: (edge: ResizeEdge | null) => string
}

// -----------------------------------------------------------------------------
// Edge detection (exported for use by CanvasNode)
// -----------------------------------------------------------------------------

const RESIZE_THRESHOLD = 6

/**
 * Detect if a mouse position (relative to the node's top-left) is near an
 * edge or corner. Returns the ResizeEdge or null.
 */
export function detectEdge(
  mouseX: number,
  mouseY: number,
  nodeWidth: number,
  nodeHeight: number,
  zoom: number,
): ResizeEdge | null {
  const t = RESIZE_THRESHOLD / Math.max(zoom, 0.1)

  const nearTop = mouseY < t
  const nearBottom = mouseY > nodeHeight - t
  const nearLeft = mouseX < t
  const nearRight = mouseX > nodeWidth - t

  // Corners take priority over edges
  if (nearTop && nearLeft) return 'topLeft'
  if (nearTop && nearRight) return 'topRight'
  if (nearBottom && nearLeft) return 'bottomLeft'
  if (nearBottom && nearRight) return 'bottomRight'
  if (nearTop) return 'top'
  if (nearBottom) return 'bottom'
  if (nearLeft) return 'left'
  if (nearRight) return 'right'
  return null
}

/**
 * Return the CSS cursor string for a given resize edge.
 */
export function getCursorForEdge(edge: ResizeEdge | null): string {
  if (!edge) return 'default'
  switch (edge) {
    case 'top':
    case 'bottom':
      return 'ns-resize'
    case 'left':
    case 'right':
      return 'ew-resize'
    case 'topLeft':
    case 'bottomRight':
      return 'nwse-resize'
    case 'topRight':
    case 'bottomLeft':
      return 'nesw-resize'
  }
}

// -----------------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------------

export function useNodeResize(
  nodeId: string,
  panelType: PanelType,
  zoomLevel: number,
): UseNodeResizeReturn {
  const resizeStateRef = useRef<ResizeState | null>(null)
  const isResizingRef = useRef(false)
  const currentEdgeRef = useRef<ResizeEdge | null>(null)

  const minSize = minimumSize(panelType)

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, edge: ResizeEdge) => {
      e.preventDefault()
      e.stopPropagation()

      const node = useCanvasStore.getState().nodes[nodeId]
      if (!node) return

      resizeStateRef.current = {
        edge,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startOrigin: { ...node.origin },
        startSize: { ...node.size },
      }
      isResizingRef.current = true
      currentEdgeRef.current = edge

      const handleMouseMove = (ev: MouseEvent) => {
        const rs = resizeStateRef.current
        if (!rs) return

        const zoom = useCanvasStore.getState().zoomLevel
        const deltaX = (ev.clientX - rs.startClientX) / zoom
        const deltaY = (ev.clientY - rs.startClientY) / zoom

        let newOriginX = rs.startOrigin.x
        let newOriginY = rs.startOrigin.y
        let newWidth = rs.startSize.width
        let newHeight = rs.startSize.height

        // Right edge: width grows with rightward drag
        if (
          rs.edge === 'right' ||
          rs.edge === 'topRight' ||
          rs.edge === 'bottomRight'
        ) {
          newWidth += deltaX
        }

        // Left edge: origin moves right, width shrinks
        if (
          rs.edge === 'left' ||
          rs.edge === 'topLeft' ||
          rs.edge === 'bottomLeft'
        ) {
          newOriginX += deltaX
          newWidth -= deltaX
        }

        // Bottom edge: height grows with downward drag
        if (
          rs.edge === 'bottom' ||
          rs.edge === 'bottomLeft' ||
          rs.edge === 'bottomRight'
        ) {
          newHeight += deltaY
        }

        // Top edge: origin moves down, height shrinks
        if (
          rs.edge === 'top' ||
          rs.edge === 'topLeft' ||
          rs.edge === 'topRight'
        ) {
          newOriginY += deltaY
          newHeight -= deltaY
        }

        // Clamp to minimum size, keeping the opposite edge fixed
        if (newWidth < minSize.width) {
          const excess = minSize.width - newWidth
          newWidth = minSize.width
          if (
            rs.edge === 'left' ||
            rs.edge === 'topLeft' ||
            rs.edge === 'bottomLeft'
          ) {
            newOriginX -= excess
          }
        }
        if (newHeight < minSize.height) {
          const excess = minSize.height - newHeight
          newHeight = minSize.height
          if (
            rs.edge === 'top' ||
            rs.edge === 'topLeft' ||
            rs.edge === 'topRight'
          ) {
            newOriginY -= excess
          }
        }

        useCanvasStore.getState().resizeNode(
          nodeId,
          { width: newWidth, height: newHeight },
          { x: newOriginX, y: newOriginY },
        )
      }

      const handleMouseUp = () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)

        isResizingRef.current = false
        currentEdgeRef.current = null

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

        resizeStateRef.current = null
      }

      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
    },
    [nodeId, panelType, zoomLevel, minSize.width, minSize.height],
  )

  const getCursor = useCallback(
    (edge: ResizeEdge | null): string => getCursorForEdge(edge),
    [],
  )

  return {
    isResizing: isResizingRef.current,
    resizeEdge: currentEdgeRef.current,
    handleResizeStart,
    getCursor,
  }
}
