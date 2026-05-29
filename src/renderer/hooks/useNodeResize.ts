// =============================================================================
// useNodeResize — edge/corner resize hook for canvas nodes.
// Supports shared border resize: when two panels share an edge, dragging it
// resizes both simultaneously.
// =============================================================================

import { useCallback, useRef } from 'react'
import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../stores/canvasStore'
import { useAppStore } from '../stores/appStore'
import { minimumSize, findSharedBorders } from '../canvas/layoutEngine'
import type { SharedBorder } from '../canvas/layoutEngine'
import type { PanelType, Point, Size } from '../../shared/types'
import { detectEdge, getCursorForEdge } from './resizeEdge'
import type { ResizeEdge } from './resizeEdge'

// Re-exported so existing importers (CanvasNode, useNodeResizeCursor,
// NodeResizeOverlay) keep importing from this module unchanged.
export { detectEdge, getCursorForEdge } from './resizeEdge'
export type { ResizeEdge } from './resizeEdge'

interface PendingResize {
  origin: Point
  size: Size
  neighbors: Array<{ id: string; origin: Point; size: Size }>
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface ResizeState {
  edge: ResizeEdge
  startClientX: number
  startClientY: number
  startOrigin: Point
  startSize: Size
}

interface NeighborStartState {
  id: string
  startOrigin: Point
  startSize: Size
  minSize: Size
}

interface UseNodeResizeReturn {
  isResizing: boolean
  resizeEdge: ResizeEdge | null
  handleResizeStart: (e: React.MouseEvent, edge: ResizeEdge) => void
  getCursor: (edge: ResizeEdge | null) => string
}

/** Whether the edge is a cardinal (non-corner) edge. */
function isCardinalEdge(edge: ResizeEdge): edge is 'top' | 'bottom' | 'left' | 'right' {
  return edge === 'top' || edge === 'bottom' || edge === 'left' || edge === 'right'
}

// -----------------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------------

export function useNodeResize(
  nodeId: string,
  panelType: PanelType,
  canvasStoreApi: StoreApi<CanvasStore>,
): UseNodeResizeReturn {
  const resizeStateRef = useRef<ResizeState | null>(null)
  const isResizingRef = useRef(false)
  const currentEdgeRef = useRef<ResizeEdge | null>(null)
  const rafId = useRef<number>(0)
  const pendingResize = useRef<PendingResize | null>(null)

  // Shared border state
  const sharedBordersRef = useRef<SharedBorder[]>([])
  const neighborStartRef = useRef<NeighborStartState[]>([])

  const minSize = minimumSize(panelType)

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, edge: ResizeEdge) => {
      e.preventDefault()
      e.stopPropagation()

      const state = canvasStoreApi.getState()
      const node = state.nodes[nodeId]
      if (!node || node.isPinned) return

      // Snapshot canvas state so this resize can be undone (Cmd+Z).
      state.pushHistory()

      resizeStateRef.current = {
        edge,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startOrigin: { ...node.origin },
        startSize: { ...node.size },
      }
      isResizingRef.current = true
      currentEdgeRef.current = edge

      // Lock the cursor for the whole document so the resize icon stays put
      // even when the pointer drifts off the (narrow) edge hit-band — which
      // happens easily when zoomed out. The `canvas-interacting` class force-
      // pins xterm to `grabbing`, which would otherwise win over body.cursor
      // when the focused panel is a terminal, so we inject a high-specificity
      // override with the actual resize cursor. Cleaned up on mouseup.
      const previousBodyCursor = document.body.style.cursor
      const resizeCursor = getCursorForEdge(edge)
      document.body.style.cursor = resizeCursor
      document.body.classList.add('canvas-interacting')
      const cursorStyleEl = document.createElement('style')
      cursorStyleEl.textContent = `*, *::before, *::after { cursor: ${resizeCursor} !important; }`
      document.head.appendChild(cursorStyleEl)

      // Detect shared borders for cardinal edges
      if (isCardinalEdge(edge)) {
        const borders = findSharedBorders(nodeId, edge, state.nodes)
        sharedBordersRef.current = borders

        // Capture neighbor start state and min sizes
        const appState = useAppStore.getState()
        const wsId = appState.selectedWorkspaceId
        const ws = appState.workspaces.find(w => w.id === wsId)

        neighborStartRef.current = borders.map((b) => {
          const neighbor = state.nodes[b.neighborId]
          const neighborPanel = ws?.panels[neighbor.panelId]
          const neighborPanelType = neighborPanel?.type ?? 'terminal'
          return {
            id: b.neighborId,
            startOrigin: { ...neighbor.origin },
            startSize: { ...neighbor.size },
            minSize: minimumSize(neighborPanelType),
          }
        })
      } else {
        sharedBordersRef.current = []
        neighborStartRef.current = []
      }

      const handleMouseMove = (ev: MouseEvent) => {
        const rs = resizeStateRef.current
        if (!rs) return

        const zoom = canvasStoreApi.getState().zoomLevel
        let deltaX = (ev.clientX - rs.startClientX) / zoom
        let deltaY = (ev.clientY - rs.startClientY) / zoom

        // Track the cursor 1:1 during the drag — the moving edge stays glued
        // to the pointer.
        const movesRightEdge =
          rs.edge === 'right' || rs.edge === 'topRight' || rs.edge === 'bottomRight'
        const movesLeftEdge =
          rs.edge === 'left' || rs.edge === 'topLeft' || rs.edge === 'bottomLeft'
        const movesBottomEdge =
          rs.edge === 'bottom' || rs.edge === 'bottomLeft' || rs.edge === 'bottomRight'
        const movesTopEdge =
          rs.edge === 'top' || rs.edge === 'topLeft' || rs.edge === 'topRight'

        if (!movesRightEdge && !movesLeftEdge) deltaX = 0
        if (!movesBottomEdge && !movesTopEdge) deltaY = 0

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

        // Clamp to minimum size, keeping the opposite edge fixed.
        const effMinW = minSize.width
        const effMinH = minSize.height
        if (newWidth < effMinW) {
          const excess = effMinW - newWidth
          newWidth = effMinW
          if (
            rs.edge === 'left' ||
            rs.edge === 'topLeft' ||
            rs.edge === 'bottomLeft'
          ) {
            newOriginX -= excess
          }
        }
        if (newHeight < effMinH) {
          const excess = effMinH - newHeight
          newHeight = effMinH
          if (
            rs.edge === 'top' ||
            rs.edge === 'topLeft' ||
            rs.edge === 'topRight'
          ) {
            newOriginY -= excess
          }
        }
        // Compute neighbor geometry for shared borders
        const neighbors: Array<{ id: string; origin: Point; size: Size }> = []
        const neighborStarts = neighborStartRef.current

        if (neighborStarts.length > 0) {
          // Clamp delta by the most constrained neighbor
          const isHorizontal = rs.edge === 'left' || rs.edge === 'right'
          let clampedDelta = isHorizontal ? deltaX : deltaY

          for (const ns of neighborStarts) {
            const available = isHorizontal
              ? ns.startSize.width - ns.minSize.width
              : ns.startSize.height - ns.minSize.height

            // For right/bottom: positive delta shrinks neighbor → clamp positive delta
            // For left/top: negative delta shrinks neighbor → clamp negative delta
            if (rs.edge === 'right' || rs.edge === 'bottom') {
              clampedDelta = Math.min(clampedDelta, available)
            } else {
              clampedDelta = Math.max(clampedDelta, -available)
            }
          }

          // Re-apply clamped delta to primary node
          if (isHorizontal) {
            if (rs.edge === 'right') {
              newWidth = rs.startSize.width + clampedDelta
            } else {
              newOriginX = rs.startOrigin.x + clampedDelta
              newWidth = rs.startSize.width - clampedDelta
            }
            if (newWidth < effMinW) {
              newWidth = effMinW
              if (rs.edge === 'left') {
                newOriginX = rs.startOrigin.x + rs.startSize.width - effMinW
              }
            }
          } else {
            if (rs.edge === 'bottom') {
              newHeight = rs.startSize.height + clampedDelta
            } else {
              newOriginY = rs.startOrigin.y + clampedDelta
              newHeight = rs.startSize.height - clampedDelta
            }
            if (newHeight < effMinH) {
              newHeight = effMinH
              if (rs.edge === 'top') {
                newOriginY = rs.startOrigin.y + rs.startSize.height - effMinH
              }
            }
          }

          // Compute neighbor geometries
          for (const ns of neighborStarts) {
            let nOriginX = ns.startOrigin.x
            let nOriginY = ns.startOrigin.y
            let nWidth = ns.startSize.width
            let nHeight = ns.startSize.height

            if (rs.edge === 'right') {
              // Neighbor's left edge moves right
              nOriginX += clampedDelta
              nWidth -= clampedDelta
            } else if (rs.edge === 'left') {
              // Neighbor's right edge moves left
              nWidth += clampedDelta
            } else if (rs.edge === 'bottom') {
              nOriginY += clampedDelta
              nHeight -= clampedDelta
            } else if (rs.edge === 'top') {
              nHeight += clampedDelta
            }

            // Clamp intermediate dimensions immediately so transient negatives
            // don't briefly land in the store before the final Math.max.
            const clampedW = Math.max(nWidth, ns.minSize.width)
            const clampedH = Math.max(nHeight, ns.minSize.height)
            neighbors.push({
              id: ns.id,
              origin: { x: nOriginX, y: nOriginY },
              size: { width: clampedW, height: clampedH },
            })
          }
        }

        // Re-anchor the grab point to the size we actually applied. When the
        // delta was clamped — by this node's own min size or by a shared-border
        // neighbor's min size — the cursor runs past where the edge can go.
        // Without this, reversing direction dead-zones until the cursor travels
        // all the way back to the stuck edge, which reads as the edge "jumping"
        // (drag right into a neighbor, then left, and nothing moves until the
        // cursor catches up). Re-anchoring keeps the edge tracking the cursor
        // immediately on reversal. It's a no-op when nothing was clamped, since
        // then the applied delta equals the raw delta.
        const appliedDeltaX = movesRightEdge
          ? newWidth - rs.startSize.width
          : movesLeftEdge
            ? newOriginX - rs.startOrigin.x
            : 0
        const appliedDeltaY = movesBottomEdge
          ? newHeight - rs.startSize.height
          : movesTopEdge
            ? newOriginY - rs.startOrigin.y
            : 0
        // Only the grab point moves; startSize/startOrigin stay at their
        // originals so the math below remains "size = startSize + delta".
        if (movesRightEdge || movesLeftEdge) {
          rs.startClientX = ev.clientX - appliedDeltaX * zoom
        }
        if (movesBottomEdge || movesTopEdge) {
          rs.startClientY = ev.clientY - appliedDeltaY * zoom
        }

        // Accumulate geometry — don't update store directly
        pendingResize.current = {
          origin: { x: newOriginX, y: newOriginY },
          size: { width: newWidth, height: newHeight },
          neighbors,
        }

        // Schedule RAF if not already pending
        if (!rafId.current) {
          rafId.current = requestAnimationFrame(() => {
            rafId.current = 0
            const pending = pendingResize.current
            if (!pending) return

            const store = canvasStoreApi.getState()
            store.resizeNode(nodeId, pending.size, pending.origin)

            // Resize shared border neighbors in the same frame
            for (const n of pending.neighbors) {
              store.resizeNode(n.id, n.size, n.origin)
            }

            pendingResize.current = null
          })
        }
      }

      const handleMouseUp = () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)

        isResizingRef.current = false
        currentEdgeRef.current = null

        document.body.style.cursor = previousBodyCursor
        document.body.classList.remove('canvas-interacting')
        cursorStyleEl.remove()

        // Cancel any pending RAF and flush the last geometry immediately
        if (rafId.current) {
          cancelAnimationFrame(rafId.current)
          rafId.current = 0
        }
        // Flush any pending geometry that the RAF didn't get to commit.
        if (pendingResize.current) {
          const pending = pendingResize.current
          const store = canvasStoreApi.getState()
          store.resizeNode(nodeId, pending.size, pending.origin)
          for (const n of pending.neighbors) {
            store.resizeNode(n.id, n.size, n.origin)
          }
          pendingResize.current = null
        }

        // Clean up
        sharedBordersRef.current = []
        neighborStartRef.current = []
        resizeStateRef.current = null
      }

      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
    },
    [nodeId, panelType, minSize.width, minSize.height],
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
