// =============================================================================
// useNodeResize — edge/corner resize hook for canvas nodes.
// Supports shared border resize: when two panels share an edge, dragging it
// resizes both simultaneously.
// =============================================================================

import { useCallback, useRef } from 'react'
import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../stores/canvasStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useAppStore } from '../stores/appStore'
import { minimumSize, snapNodeToGrid, findSharedBorders } from '../canvas/layoutEngine'
import type { SharedBorder } from '../canvas/layoutEngine'
import type { PanelType, Point, Size } from '../../shared/types'

interface PendingResize {
  origin: Point
  size: Size
  neighbors: Array<{ id: string; origin: Point; size: Size }>
}

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

  // Shift top edge detection rightward to avoid conflicting with the title bar drag handle
  const TOP_RESIZE_OFFSET = 60
  const nearTop = mouseY < t && mouseX > TOP_RESIZE_OFFSET
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
  zoomLevel: number,
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

      resizeStateRef.current = {
        edge,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startOrigin: { ...node.origin },
        startSize: { ...node.size },
      }
      isResizingRef.current = true
      currentEdgeRef.current = edge

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
            // Re-clamp primary min size
            if (newWidth < minSize.width) {
              newWidth = minSize.width
              if (rs.edge === 'left') {
                newOriginX = rs.startOrigin.x + rs.startSize.width - minSize.width
              }
            }
          } else {
            if (rs.edge === 'bottom') {
              newHeight = rs.startSize.height + clampedDelta
            } else {
              newOriginY = rs.startOrigin.y + clampedDelta
              newHeight = rs.startSize.height - clampedDelta
            }
            if (newHeight < minSize.height) {
              newHeight = minSize.height
              if (rs.edge === 'top') {
                newOriginY = rs.startOrigin.y + rs.startSize.height - minSize.height
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

            neighbors.push({
              id: ns.id,
              origin: { x: nOriginX, y: nOriginY },
              size: { width: Math.max(nWidth, ns.minSize.width), height: Math.max(nHeight, ns.minSize.height) },
            })
          }
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
              canvasStoreApi.getState().resizeNode(n.id, n.size, n.origin)
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

        // Cancel any pending RAF and flush the last geometry immediately
        if (rafId.current) {
          cancelAnimationFrame(rafId.current)
          rafId.current = 0
        }
        if (pendingResize.current) {
          const store = canvasStoreApi.getState()
          store.resizeNode(
            nodeId,
            pendingResize.current.size,
            pendingResize.current.origin,
          )
          for (const n of pendingResize.current.neighbors) {
            canvasStoreApi.getState().resizeNode(n.id, n.size, n.origin)
          }
          pendingResize.current = null
        }

        // Snap primary node to grid if enabled
        const settings = useSettingsStore.getState()
        if (settings.snapToGridEnabled) {
          snapNodeToGrid(canvasStoreApi, nodeId, settings.gridSpacing, false)

          // Adjust neighbors so shared border stays aligned after snap
          if (sharedBordersRef.current.length > 0) {
            const snappedNode = canvasStoreApi.getState().nodes[nodeId]
            if (snappedNode) {
              const rs = resizeStateRef.current
              if (rs && isCardinalEdge(rs.edge)) {
                const isHorizontal = rs.edge === 'left' || rs.edge === 'right'
                for (const border of sharedBordersRef.current) {
                  const neighbor = canvasStoreApi.getState().nodes[border.neighborId]
                  if (!neighbor) continue

                  if (isHorizontal) {
                    // Align the shared vertical border
                    let sharedX: number
                    if (rs.edge === 'right') {
                      sharedX = snappedNode.origin.x + snappedNode.size.width
                    } else {
                      sharedX = snappedNode.origin.x
                    }

                    if (border.neighborEdge === 'left') {
                      const widthDelta = sharedX - neighbor.origin.x
                      canvasStoreApi.getState().resizeNode(
                        border.neighborId,
                        { width: neighbor.size.width - widthDelta, height: neighbor.size.height },
                        { x: sharedX, y: neighbor.origin.y },
                      )
                    } else {
                      canvasStoreApi.getState().resizeNode(
                        border.neighborId,
                        { width: sharedX - neighbor.origin.x, height: neighbor.size.height },
                      )
                    }
                  } else {
                    let sharedY: number
                    if (rs.edge === 'bottom') {
                      sharedY = snappedNode.origin.y + snappedNode.size.height
                    } else {
                      sharedY = snappedNode.origin.y
                    }

                    if (border.neighborEdge === 'top') {
                      const heightDelta = sharedY - neighbor.origin.y
                      canvasStoreApi.getState().resizeNode(
                        border.neighborId,
                        { width: neighbor.size.width, height: neighbor.size.height - heightDelta },
                        { x: neighbor.origin.x, y: sharedY },
                      )
                    } else {
                      canvasStoreApi.getState().resizeNode(
                        border.neighborId,
                        { width: neighbor.size.width, height: sharedY - neighbor.origin.y },
                      )
                    }
                  }
                }
              }
            }
          }
        }

        // Clean up
        sharedBordersRef.current = []
        neighborStartRef.current = []
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
