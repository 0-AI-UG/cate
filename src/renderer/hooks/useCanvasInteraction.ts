// =============================================================================
// useCanvasInteraction — custom hook for canvas pan/zoom interaction.
// Ported from CanvasView.swift scroll/zoom/right-click-drag handlers.
// =============================================================================

import { useCallback, useRef, useState } from 'react'
import { useCanvasStore } from '../stores/canvasStore'
import { useSettingsStore } from '../stores/settingsStore'
import { viewToCanvas } from '../lib/coordinates'
import { ZOOM_MIN, ZOOM_MAX } from '../../shared/types'
import type { Point } from '../../shared/types'

// How many pixels the mouse must move before a right-click becomes a drag
const RIGHT_CLICK_DRAG_THRESHOLD = 4

export interface CanvasContextMenuState {
  x: number       // screen X for the menu
  y: number       // screen Y for the menu
  canvasPoint: Point  // canvas-space coords where new panels should be created
}

interface CanvasInteractionHandlers {
  handleWheel: (e: React.WheelEvent<HTMLDivElement>) => void
  handleMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void
  handleMouseMove: (e: React.MouseEvent<HTMLDivElement>) => void
  handleMouseUp: (e: React.MouseEvent<HTMLDivElement>) => void
  handleContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void
  canvasContextMenu: CanvasContextMenuState | null
  closeCanvasContextMenu: () => void
}

export function useCanvasInteraction(
  canvasRef: React.RefObject<HTMLDivElement | null>,
): CanvasInteractionHandlers {
  const isPanning = useRef(false)
  const lastPanPos = useRef<{ x: number; y: number } | null>(null)

  // Right-click drag detection
  const rightClickStart = useRef<{ x: number; y: number } | null>(null)
  const rightClickDidDrag = useRef(false)

  const [canvasContextMenu, setCanvasContextMenu] =
    useState<CanvasContextMenuState | null>(null)

  const closeCanvasContextMenu = useCallback(() => {
    setCanvasContextMenu(null)
  }, [])

  // ---------------------------------------------------------------------------
  // Wheel: Cmd+scroll = zoom around cursor, otherwise pan
  // ---------------------------------------------------------------------------

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      // If a node is focused and the scroll originated inside it, let the
      // node content (terminal scrollback, editor scroll, etc.) handle it.
      const { focusedNodeId } = useCanvasStore.getState()
      if (focusedNodeId) {
        const nodeEl = document.querySelector(`[data-node-id="${focusedNodeId}"]`)
        if (nodeEl && nodeEl.contains(e.target as Node)) {
          return
        }
      }

      e.preventDefault()

      const { zoomLevel, viewportOffset, setZoom, setViewportOffset } =
        useCanvasStore.getState()
      const { zoomSpeed } = useSettingsStore.getState()

      if (e.metaKey || e.ctrlKey) {
        // Zoom around cursor — port of CanvasView.swift zoomAround()
        const rect = canvasRef.current?.getBoundingClientRect()
        if (!rect) return

        const cursorViewPoint = {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        }

        const scrollDelta = -e.deltaY
        const zoomDelta = scrollDelta * 0.01 * zoomSpeed

        const oldZoom = zoomLevel
        const newZoom = Math.min(
          Math.max(oldZoom + zoomDelta, ZOOM_MIN),
          ZOOM_MAX,
        )
        if (newZoom === oldZoom) return

        // Keep cursor fixed in canvas space:
        //   cursorView = canvasPoint * oldZoom + oldOffset
        //   cursorView = canvasPoint * newZoom + newOffset
        //   => newOffset = cursorView - canvasPoint * newZoom
        const canvasPoint = viewToCanvas(cursorViewPoint, oldZoom, viewportOffset)
        setZoom(newZoom)
        setViewportOffset({
          x: cursorViewPoint.x - canvasPoint.x * newZoom,
          y: cursorViewPoint.y - canvasPoint.y * newZoom,
        })
      } else {
        // Two-finger scroll = pan (negate for natural scrolling)
        setViewportOffset({
          x: viewportOffset.x - e.deltaX,
          y: viewportOffset.y - e.deltaY,
        })
      }
    },
    [canvasRef],
  )

  // ---------------------------------------------------------------------------
  // Mouse: right-click drag for panning, left-click on background to unfocus
  // ---------------------------------------------------------------------------

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button === 2) {
        // Right-click: track start position for drag detection
        isPanning.current = true
        lastPanPos.current = { x: e.clientX, y: e.clientY }
        rightClickStart.current = { x: e.clientX, y: e.clientY }
        rightClickDidDrag.current = false
        e.preventDefault()
      } else if (e.button === 0) {
        // Left-click on canvas background (not on a node) => unfocus
        // Only unfocus if the click target is the canvas itself (not a child node)
        if (e.target === e.currentTarget || e.target === canvasRef.current) {
          useCanvasStore.getState().unfocus()
        }
      }
    },
    [canvasRef],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isPanning.current || !lastPanPos.current) return

      // Check if the right-click has moved far enough to count as a drag
      if (!rightClickDidDrag.current && rightClickStart.current) {
        const dx = e.clientX - rightClickStart.current.x
        const dy = e.clientY - rightClickStart.current.y
        if (Math.sqrt(dx * dx + dy * dy) > RIGHT_CLICK_DRAG_THRESHOLD) {
          rightClickDidDrag.current = true
        }
      }

      const dx = e.clientX - lastPanPos.current.x
      const dy = e.clientY - lastPanPos.current.y

      const { viewportOffset, setViewportOffset } =
        useCanvasStore.getState()

      setViewportOffset({
        x: viewportOffset.x + dx,
        y: viewportOffset.y + dy,
      })

      lastPanPos.current = { x: e.clientX, y: e.clientY }
    },
    [],
  )

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button === 2) {
        // If the right-click never dragged, show the canvas background context menu
        // — but only if the click landed on empty canvas (not on a node).
        if (!rightClickDidDrag.current) {
          const target = e.target as HTMLElement
          const isOnNode = target.closest('[data-node-id]') !== null
          if (!isOnNode) {
            const rect = canvasRef.current?.getBoundingClientRect()
            if (rect) {
              const viewPoint = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
              }
              const { zoomLevel, viewportOffset } = useCanvasStore.getState()
              const canvasPoint = viewToCanvas(viewPoint, zoomLevel, viewportOffset)
              setCanvasContextMenu({
                x: e.clientX,
                y: e.clientY,
                canvasPoint,
              })
            }
          }
        }
      }

      isPanning.current = false
      lastPanPos.current = null
      rightClickStart.current = null
    },
    [canvasRef],
  )

  // ---------------------------------------------------------------------------
  // Context menu: suppress the browser default (our custom menu is shown in
  // mouseup above; this just prevents the OS menu from also appearing).
  // ---------------------------------------------------------------------------

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault()
    },
    [],
  )

  return {
    handleWheel,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleContextMenu,
    canvasContextMenu,
    closeCanvasContextMenu,
  }
}
