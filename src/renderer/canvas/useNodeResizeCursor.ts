// =============================================================================
// useNodeResizeCursor — edge detection + cursor rendering for CanvasNode.
// Returns mousedown/mousemove handlers that mirror the inline behavior from
// CanvasNode (start resize on edge mousedown; update cursor on hover).
// =============================================================================

import React, { useCallback } from 'react'
import { detectEdge, getCursorForEdge } from '../hooks/useNodeResize'
import type { ResizeEdge } from '../hooks/useNodeResize'
import type { CanvasNodeState } from '../../shared/types'

export function useNodeResizeCursor(
  nodeRef: React.RefObject<HTMLDivElement | null>,
  node: CanvasNodeState | undefined,
  zoomLevel: number,
  handleResizeStart: (e: React.MouseEvent, edge: ResizeEdge) => void,
) {
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 2) {
        e.stopPropagation()
        return
      }
      if (e.button !== 0) return
      if (!nodeRef.current || !node) return

      const rect = nodeRef.current.getBoundingClientRect()
      const localX = e.clientX - rect.left
      const localY = e.clientY - rect.top

      const edge = detectEdge(localX, localY, rect.width, rect.height, zoomLevel)
      if (edge) {
        handleResizeStart(e, edge)
      }
    },
    [node, zoomLevel, handleResizeStart, nodeRef],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!nodeRef.current) return
      if (document.body.classList.contains('canvas-interacting')) return
      const rect = nodeRef.current.getBoundingClientRect()
      const localX = e.clientX - rect.left
      const localY = e.clientY - rect.top
      const edge = detectEdge(localX, localY, rect.width, rect.height, zoomLevel)
      const cursor = getCursorForEdge(edge)
      if (nodeRef.current.style.cursor !== cursor) {
        nodeRef.current.style.cursor = cursor
      }
    },
    [zoomLevel, nodeRef],
  )

  return { handleMouseDown, handleMouseMove }
}
