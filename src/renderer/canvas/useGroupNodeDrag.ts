// =============================================================================
// useGroupNodeDrag — moves every selected canvas node together when the user
// drags a node that's part of a multi-selection. The dock-aware drag op
// (useCanvasNodeDrag) only ever moves a single node, so this takes over the
// gesture for groups: a pure canvas-space translate of all selected nodes,
// with no docking/detach semantics (those don't apply to a multi-node move).
// =============================================================================

import React, { useCallback } from 'react'
import type { Point } from '../../shared/types'
import type { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { acquireBodyClass, releaseBodyClass } from '../lib/dom/bodyClassRefcount'
import { isGroupDragMember } from '../stores/canvas/selectionModel'

const DEAD_ZONE_PX = 4

export function useGroupNodeDrag(
  nodeId: string,
  canvasApi: ReturnType<typeof useCanvasStoreApi>,
  // Shared with the single-node drag op so the click that follows mouseup is
  // suppressed (otherwise the node's onClick collapses the selection to one).
  wasDragged: { current: boolean },
) {
  // Returns true when it has hijacked the gesture as a group move; the caller
  // must then NOT fall through to the single-node dock drag.
  const startGroupDrag = useCallback(
    (e: React.MouseEvent): boolean => {
      if (e.button !== 0) return false
      const state = canvasApi.getState()
      const selected = state.selection
      // Only take over for a real multi-selection that includes this node.
      if (!isGroupDragMember(selected, nodeId)) return false

      const startOrigins = new Map<string, Point>()
      for (const id of selected) {
        const n = state.nodes[id]
        if (n) startOrigins.set(id, { x: n.origin.x, y: n.origin.y })
      }
      if (startOrigins.size <= 1) return false

      const zoom = state.zoomLevel
      const startX = e.clientX
      const startY = e.clientY
      let moved = false
      let pushed = false

      const onMove = (ev: MouseEvent) => {
        const dxClient = ev.clientX - startX
        const dyClient = ev.clientY - startY
        if (!moved) {
          if (Math.hypot(dxClient, dyClient) < DEAD_ZONE_PX) return
          moved = true
          wasDragged.current = true
          acquireBodyClass('canvas-interacting')
        }
        // History once, on the first real movement.
        if (!pushed) {
          canvasApi.getState().pushHistory()
          pushed = true
        }
        const dxCanvas = dxClient / zoom
        const dyCanvas = dyClient / zoom
        const moveNode = canvasApi.getState().moveNode
        for (const [id, origin] of startOrigins) {
          moveNode(id, { x: origin.x + dxCanvas, y: origin.y + dyCanvas })
        }
      }

      // The selection translate is anchored to a single zoom snapshotted at
      // mousedown; letting a wheel zoom/pan the world mid-drag would slide the
      // selection off the cursor. Swallow wheel input for the gesture's life.
      const onWheel = (ev: WheelEvent) => {
        ev.preventDefault()
        ev.stopPropagation()
      }

      const teardown = () => {
        window.removeEventListener('mousemove', onMove, true)
        window.removeEventListener('mouseup', onUp, true)
        window.removeEventListener('blur', onBlur)
        window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions)
        if (moved) releaseBodyClass('canvas-interacting')
      }

      const onUp = () => {
        teardown()
        // Keep wasDragged true through the click that fires after mouseup, then
        // clear it so a later plain click can select again.
        if (moved) setTimeout(() => { wasDragged.current = false }, 0)
      }

      // Cmd+Tab (or any window blur) mid-drag fires no mouseup. Without this the
      // capture listeners stay attached and keep translating the selection on
      // every buttonless mousemove once the user returns. Tear down and clear.
      const onBlur = () => {
        teardown()
        if (moved) wasDragged.current = false
      }

      window.addEventListener('mousemove', onMove, true)
      window.addEventListener('mouseup', onUp, true)
      window.addEventListener('blur', onBlur)
      window.addEventListener('wheel', onWheel, { capture: true, passive: false })
      // Prevent the press from kicking off the single-node drag/focus path; the
      // following click still fires (so a no-drag press collapses to one node).
      e.preventDefault()
      e.stopPropagation()
      return true
    },
    [canvasApi, nodeId, wasDragged],
  )

  return { startGroupDrag }
}
