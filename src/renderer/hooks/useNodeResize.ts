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
import { minimumSize, findSharedBorders } from '../canvas/layoutEngine'
import type { SharedBorder, SnapLine } from '../canvas/layoutEngine'
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

  // Shift the bare top edge detection rightward to avoid conflicting with the
  // title bar drag handle. Corners still work at the full width.
  const TOP_RESIZE_OFFSET = 60
  const nearTop = mouseY < t
  const nearBottom = mouseY > nodeHeight - t
  const nearLeft = mouseX < t
  const nearRight = mouseX > nodeWidth - t

  // Corners take priority over edges
  if (nearTop && nearLeft) return 'topLeft'
  if (nearTop && nearRight) return 'topRight'
  if (nearBottom && nearLeft) return 'bottomLeft'
  if (nearBottom && nearRight) return 'bottomRight'
  if (nearTop && mouseX > TOP_RESIZE_OFFSET) return 'top'
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
  // Track which axes were magnetically snapped in the last resize frame
  const lastMagneticAxesRef = useRef<{ x: boolean; y: boolean }>({ x: false, y: false })

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
        // to the pointer. Grid snapping is applied once on mouseup so the
        // node still lands on-grid without the cursor visibly detaching from
        // the handle mid-drag.
        const settingsLive = useSettingsStore.getState()
        {
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
        }

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
        // When snap-to-grid is on, round the effective minimum up to the
        // grid so the clamp doesn't push width/height (or, for left/top
        // edges, origin) off-grid as the node bottoms out.
        const g = settingsLive.gridSpacing
        const effMinW = settingsLive.snapToGridEnabled
          ? Math.ceil(minSize.width / g) * g
          : minSize.width
        const effMinH = settingsLive.snapToGridEnabled
          ? Math.ceil(minSize.height / g) * g
          : minSize.height
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
            // Re-clamp primary min size (grid-aligned when snap is on)
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

        // -------- Snap guides (visual feedback only) --------
        // Live grid snapping happens up-front via the delta; this block only
        // surfaces neighbor-edge alignment guides while dragging.
        const settings = useSettingsStore.getState()
        const magneticAxes = { x: false, y: false }
        const guideLines: SnapLine[] = []

        if (settings.snapToGridEnabled && neighborStarts.length === 0) {
          // Guide-only mode: no magnetic pull on the edge during hold, so the
          // cursor stays locked to the corner/edge 1:1. Show snap guides only
          // when the moving edge is within GUIDE_THRESHOLD (in screen pixels,
          // converted to canvas units) of a neighbor edge.
          const GUIDE_THRESHOLD = 8 / zoom
          const state2 = canvasStoreApi.getState()

          const xCandidates: number[] = []
          const yCandidates: number[] = []
          for (const o of Object.values(state2.nodes)) {
            if (o.id === nodeId) continue
            xCandidates.push(o.origin.x, o.origin.x + o.size.width)
            yCandidates.push(o.origin.y, o.origin.y + o.size.height)
          }
          for (const r of Object.values(state2.regions)) {
            xCandidates.push(r.origin.x, r.origin.x + r.size.width)
            yCandidates.push(r.origin.y, r.origin.y + r.size.height)
          }

          const nearest = (value: number, candidates: number[]) => {
            let best = value
            let bestDist = GUIDE_THRESHOLD
            for (const c of candidates) {
              const d = Math.abs(c - value)
              if (d < bestDist) {
                bestDist = d
                best = c
              }
            }
            return { best, dist: bestDist }
          }

          const movesLeft =
            rs.edge === 'left' || rs.edge === 'topLeft' || rs.edge === 'bottomLeft'
          const movesRight =
            rs.edge === 'right' || rs.edge === 'topRight' || rs.edge === 'bottomRight'
          const movesTop =
            rs.edge === 'top' || rs.edge === 'topLeft' || rs.edge === 'topRight'
          const movesBottom =
            rs.edge === 'bottom' || rs.edge === 'bottomLeft' || rs.edge === 'bottomRight'

          if (movesLeft) {
            const { best, dist } = nearest(newOriginX, xCandidates)
            if (dist < GUIDE_THRESHOLD) guideLines.push({ axis: 'x', position: best, type: 'edge' })
          } else if (movesRight) {
            const { best, dist } = nearest(newOriginX + newWidth, xCandidates)
            if (dist < GUIDE_THRESHOLD) guideLines.push({ axis: 'x', position: best, type: 'edge' })
          }

          if (movesTop) {
            const { best, dist } = nearest(newOriginY, yCandidates)
            if (dist < GUIDE_THRESHOLD) guideLines.push({ axis: 'y', position: best, type: 'edge' })
          } else if (movesBottom) {
            const { best, dist } = nearest(newOriginY + newHeight, yCandidates)
            if (dist < GUIDE_THRESHOLD) guideLines.push({ axis: 'y', position: best, type: 'edge' })
          }
        }

        lastMagneticAxesRef.current = magneticAxes
        canvasStoreApi.getState().setSnapGuides({ lines: guideLines })

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
        // Always run the mouseup snap pass, even if no resize frame is
        // pending. The RAF flush nulls pendingResize as soon as it commits,
        // so a brief pause before release would otherwise skip grid snap
        // entirely and leave the node at its unsnapped 1:1 cursor position.
        {
          const rs = resizeStateRef.current
          const settingsLive = useSettingsStore.getState()
          const storeState = canvasStoreApi.getState()
          const currentNode = storeState.nodes[nodeId]
          const fallback = currentNode
            ? {
                origin: { ...currentNode.origin },
                size: { ...currentNode.size },
                neighbors: neighborStartRef.current.map((ns) => {
                  const n = storeState.nodes[ns.id]
                  return n
                    ? { id: ns.id, origin: { ...n.origin }, size: { ...n.size } }
                    : { id: ns.id, origin: ns.startOrigin, size: ns.startSize }
                }),
              }
            : null
          let { origin, size, neighbors } = pendingResize.current ?? fallback ?? {
            origin: rs?.startOrigin ?? { x: 0, y: 0 },
            size: rs?.startSize ?? { width: 0, height: 0 },
            neighbors: [] as Array<{ id: string; origin: Point; size: Size }>,
          }

          // Snap the moving edges to the grid on release. The cursor tracks
          // 1:1 during the drag (so the handle never visually detaches), and
          // we only commit the grid-aligned values here on mouseup.
          if (rs && settingsLive.snapToGridEnabled) {
            const g = settingsLive.gridSpacing
            const snap = (v: number) => Math.round(v / g) * g

            const movesRight =
              rs.edge === 'right' || rs.edge === 'topRight' || rs.edge === 'bottomRight'
            const movesLeft =
              rs.edge === 'left' || rs.edge === 'topLeft' || rs.edge === 'bottomLeft'
            const movesBottom =
              rs.edge === 'bottom' || rs.edge === 'bottomLeft' || rs.edge === 'bottomRight'
            const movesTop =
              rs.edge === 'top' || rs.edge === 'topLeft' || rs.edge === 'topRight'

            const effMinW = Math.ceil(minSize.width / g) * g
            const effMinH = Math.ceil(minSize.height / g) * g

            let newOriginX = origin.x
            let newOriginY = origin.y
            let newWidth = size.width
            let newHeight = size.height

            if (movesRight) {
              newWidth = Math.max(effMinW, snap(origin.x + size.width) - origin.x)
            } else if (movesLeft) {
              const right = origin.x + size.width
              newOriginX = Math.min(snap(origin.x), right - effMinW)
              newWidth = right - newOriginX
            }
            if (movesBottom) {
              newHeight = Math.max(effMinH, snap(origin.y + size.height) - origin.y)
            } else if (movesTop) {
              const bottom = origin.y + size.height
              newOriginY = Math.min(snap(origin.y), bottom - effMinH)
              newHeight = bottom - newOriginY
            }

            // Re-derive neighbor geometry from the snapped primary so their
            // shared edge stays aligned with the primary's snapped edge.
            const snappedNeighbors: typeof neighbors = []
            for (const n of neighbors) {
              const ns = neighborStartRef.current.find((s) => s.id === n.id)
              if (!ns) {
                snappedNeighbors.push(n)
                continue
              }
              let nOriginX = ns.startOrigin.x
              let nOriginY = ns.startOrigin.y
              let nWidth = ns.startSize.width
              let nHeight = ns.startSize.height

              if (rs.edge === 'right') {
                const newRightOfPrimary = newOriginX + newWidth
                nWidth = ns.startOrigin.x + ns.startSize.width - newRightOfPrimary
                nOriginX = newRightOfPrimary
              } else if (rs.edge === 'left') {
                nWidth = newOriginX - ns.startOrigin.x
              } else if (rs.edge === 'bottom') {
                const newBottomOfPrimary = newOriginY + newHeight
                nHeight = ns.startOrigin.y + ns.startSize.height - newBottomOfPrimary
                nOriginY = newBottomOfPrimary
              } else if (rs.edge === 'top') {
                nHeight = newOriginY - ns.startOrigin.y
              }

              snappedNeighbors.push({
                id: n.id,
                origin: { x: nOriginX, y: nOriginY },
                size: {
                  width: Math.max(nWidth, ns.minSize.width),
                  height: Math.max(nHeight, ns.minSize.height),
                },
              })
            }

            origin = { x: newOriginX, y: newOriginY }
            size = { width: newWidth, height: newHeight }
            neighbors = snappedNeighbors
          }

          const store = canvasStoreApi.getState()
          store.resizeNode(nodeId, size, origin)
          for (const n of neighbors) {
            store.resizeNode(n.id, n.size, n.origin)
          }
          pendingResize.current = null
        }

        // Clear any snap guides shown during the resize
        canvasStoreApi.getState().clearSnapGuides()
        lastMagneticAxesRef.current = { x: false, y: false }

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
