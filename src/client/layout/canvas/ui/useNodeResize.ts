// Edge and corner resize of a canvas node. Neighbours sharing the dragged
// edge resize with it. The geometry previews locally each frame and goes to
// the document as one `setNodeRects` op on release.

import type React from 'react'
import { useCallback, useEffect, useRef } from 'react'
import { findSharedBorders, snapResizeDelta, type Point, type Size } from '@workspace/canvas/contract'
import type { NodeId } from '@workspace/document/contract'
import type { CanvasViewStore } from '../store'
import { canvasSetting } from '../settings'
import { pinDocumentCursor } from '@client/layout/drag'
import { edgeFlags, getCursorForEdge, isCardinalEdge, type ResizeEdge } from '../parts/resizeEdge'

interface ResizeState {
  edge: ResizeEdge
  startClientX: number
  startClientY: number
  startOrigin: Point
  startSize: Size
}

interface NeighborStart {
  id: NodeId
  startOrigin: Point
  startSize: Size
  minSize: Size
}

interface Pending {
  origin: Point
  size: Size
  neighbors: { id: NodeId; origin: Point; size: Size }[]
}

/** `minSizeOf` gives a node's minimum size (its active panel's definition). */
export function useNodeResize(
  nodeId: NodeId,
  store: CanvasViewStore,
  minSizeOf: (nodeId: NodeId) => Size,
): { handleResizeStart: (e: React.MouseEvent, edge: ResizeEdge) => void } {
  const cancelRef = useRef<(() => void) | null>(null)
  useEffect(() => () => cancelRef.current?.(), [])

  const handleResizeStart = useCallback((e: React.MouseEvent, edge: ResizeEdge) => {
    e.preventDefault()
    e.stopPropagation()
    const state = store.getState()
    const node = state.nodes[nodeId]
    if (!node || node.isPinned) return
    // A press while a previous resize is live would pin the cursor twice.
    cancelRef.current?.()

    const rs: ResizeState = {
      edge,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startOrigin: { ...node.origin },
      startSize: { ...node.size },
    }
    const minSize = minSizeOf(nodeId)
    const moving = edgeFlags(edge)

    // Keep the resize cursor even when the pointer leaves the thin band,
    // which happens easily when zoomed out.
    const previousBodyCursor = document.body.style.cursor
    const cursor = getCursorForEdge(edge)
    document.body.style.cursor = cursor
    const unpinCursor = pinDocumentCursor(cursor, 'node-edge-resize')

    const neighborStarts: NeighborStart[] = isCardinalEdge(edge)
      ? findSharedBorders(nodeId, edge, state.nodes)
        .filter((b) => !state.nodes[b.neighborId].isPinned)
        .map((b) => {
          const n = state.nodes[b.neighborId]
          return { id: n.id, startOrigin: { ...n.origin }, startSize: { ...n.size }, minSize: minSizeOf(n.id) }
        })
      : []

    let pending: Pending | null = null
    let raf = 0

    // The edge tracks the cursor 1:1 while dragging; grid snapping waits for
    // release so the edge never lags the pointer.
    const compute = (clientX: number, clientY: number, snap: boolean) => {
      const zoom = store.getState().zoomLevel
      let dx = moving.left || moving.right ? (clientX - rs.startClientX) / zoom : 0
      let dy = moving.top || moving.bottom ? (clientY - rs.startClientY) / zoom : 0
      // Snapping the delta, not the rect, keeps the neighbour math consistent.
      if (snap) ({ x: dx, y: dy } = snapResizeDelta(moving, rs.startOrigin, rs.startSize, { x: dx, y: dy }))

      let x = rs.startOrigin.x
      let y = rs.startOrigin.y
      let w = rs.startSize.width
      let h = rs.startSize.height
      if (moving.right) w += dx
      if (moving.left) { x += dx; w -= dx }
      if (moving.bottom) h += dy
      if (moving.top) { y += dy; h -= dy }

      // Clamp to the minimum with the opposite edge fixed.
      if (w < minSize.width) {
        if (moving.left) x -= minSize.width - w
        w = minSize.width
      }
      if (h < minSize.height) {
        if (moving.top) y -= minSize.height - h
        h = minSize.height
      }

      const neighbors: Pending['neighbors'] = []
      if (neighborStarts.length > 0) {
        // The most constrained neighbour limits the shared edge.
        const horizontal = edge === 'left' || edge === 'right'
        let delta = horizontal ? dx : dy
        for (const ns of neighborStarts) {
          const available = horizontal ? ns.startSize.width - ns.minSize.width : ns.startSize.height - ns.minSize.height
          delta = edge === 'right' || edge === 'bottom' ? Math.min(delta, available) : Math.max(delta, -available)
        }
        if (horizontal) {
          if (edge === 'right') w = rs.startSize.width + delta
          else { x = rs.startOrigin.x + delta; w = rs.startSize.width - delta }
          if (w < minSize.width) {
            w = minSize.width
            if (edge === 'left') x = rs.startOrigin.x + rs.startSize.width - minSize.width
          }
        } else {
          if (edge === 'bottom') h = rs.startSize.height + delta
          else { y = rs.startOrigin.y + delta; h = rs.startSize.height - delta }
          if (h < minSize.height) {
            h = minSize.height
            if (edge === 'top') y = rs.startOrigin.y + rs.startSize.height - minSize.height
          }
        }
        for (const ns of neighborStarts) {
          let nx = ns.startOrigin.x
          let ny = ns.startOrigin.y
          let nw = ns.startSize.width
          let nh = ns.startSize.height
          if (edge === 'right') { nx += delta; nw -= delta }
          else if (edge === 'left') nw += delta
          else if (edge === 'bottom') { ny += delta; nh -= delta }
          else if (edge === 'top') nh += delta
          neighbors.push({ id: ns.id, origin: { x: nx, y: ny }, size: { width: Math.max(nw, ns.minSize.width), height: Math.max(nh, ns.minSize.height) } })
        }
      }

      // Re-anchor the grab point to what was applied. When a minimum clamped
      // the edge, the cursor ran past it; without this, reversing direction
      // dead-zones until the cursor travels back to the stuck edge.
      const appliedX = moving.right ? w - rs.startSize.width : moving.left ? x - rs.startOrigin.x : 0
      const appliedY = moving.bottom ? h - rs.startSize.height : moving.top ? y - rs.startOrigin.y : 0
      if (moving.left || moving.right) rs.startClientX = clientX - appliedX * zoom
      if (moving.top || moving.bottom) rs.startClientY = clientY - appliedY * zoom

      pending = { origin: { x, y }, size: { width: w, height: h }, neighbors }
    }

    const flush = () => {
      const p = pending
      pending = null
      if (!p) return
      store.getState().previewRects([
        { nodeId, rect: { origin: p.origin, size: p.size } },
        ...p.neighbors.map((n) => ({ nodeId: n.id, rect: { origin: n.origin, size: n.size } })),
      ])
    }

    // A bare click on the edge must not snap an off-grid edge onto the grid.
    let moved = false

    const onMove = (ev: MouseEvent) => {
      moved = true
      compute(ev.clientX, ev.clientY, false)
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0
          flush()
        })
      }
    }

    const detach = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onBlur)
      if (cancelRef.current === onBlur) cancelRef.current = null
      document.body.style.cursor = previousBodyCursor
      unpinCursor()
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }

    const onUp = (ev: MouseEvent) => {
      if (moved) compute(ev.clientX, ev.clientY, canvasSetting('snapToGrid') && !ev.altKey)
      detach()
      flush()
      store.getState().commitPreview()
    }

    // A window blur (Cmd+Tab) fires no mouseup: end in place, keeping the
    // last previewed geometry, without the release snap.
    const onBlur = () => {
      detach()
      pending = null
      store.getState().commitPreview()
    }

    cancelRef.current = onBlur
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onBlur)
  }, [nodeId, store, minSizeOf])

  return { handleResizeStart }
}
