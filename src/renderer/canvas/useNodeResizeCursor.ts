// =============================================================================
// useNodeResizeCursor — edge detection + cursor rendering for CanvasNode.
// Returns mousedown/mousemove handlers that mirror the inline behavior from
// CanvasNode (start resize on edge mousedown; update cursor on hover).
// =============================================================================

import React, { useCallback } from 'react'
import { detectEdge, getCursorForEdge } from '../hooks/useNodeResize'
import type { ResizeEdge } from '../hooks/useNodeResize'
import type { CanvasNodeState } from '../../shared/types'
import { isOverScrollbar } from './scrollbar'

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
      // First-gesture-wins: if a drag has already begun (e.g. via DockTabBar
      // mousedown that bubbled here from the tab-bar edge), do not also
      // start a resize on the same gesture.
      if (document.body.classList.contains('canvas-dragging')) return

      const rect = nodeRef.current.getBoundingClientRect()
      const localX = e.clientX - rect.left
      const localY = e.clientY - rect.top

      const edge = detectEdge(localX, localY, rect.width, rect.height, zoomLevel)
      if (edge) {
        // Let the content's scrollbar win the edge — don't start a resize on a
        // mousedown that's actually grabbing the scrollbar thumb.
        if (isOverScrollbar(nodeRef.current, e.clientX, e.clientY)) return
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
      let edge = detectEdge(localX, localY, rect.width, rect.height, zoomLevel)
      // Near an edge but over the content's scrollbar: show the default cursor,
      // not a resize cursor, so the scrollbar reads as draggable.
      if (edge && isOverScrollbar(nodeRef.current, e.clientX, e.clientY)) {
        edge = null
      }
      const cursor = getCursorForEdge(edge)
      if (nodeRef.current.style.cursor !== cursor) {
        nodeRef.current.style.cursor = cursor
      }
    },
    [zoomLevel, nodeRef],
  )

  return { handleMouseDown, handleMouseMove }
}
