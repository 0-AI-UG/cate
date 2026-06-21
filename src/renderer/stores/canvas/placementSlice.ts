// =============================================================================
// Placement slice — interactive ghost placement: compute recommended spots,
// zoom out to reveal them, and commit the user's pick (numbered ghost, free
// click-anywhere, or cancel). The latest pointer position lives on ctx.
// =============================================================================

import type { Rect } from '../../../shared/types'
import { ZOOM_MIN, ZOOM_MAX, PANEL_DEFAULT_SIZES } from '../../../shared/types'
import { viewToCanvas as viewToCanvasCoords } from '../../lib/canvas/coordinates'
import { recommendPlacements, nudgeToFree, type PlacementTrace } from '../../canvas/placement'
import type { CanvasGet, CanvasSet, CanvasStoreActions } from './storeTypes'
import type { CanvasStoreCtx } from './storeCtx'
import { focusedNodeId } from './selectionModel'

type PlacementActions = Pick<
  CanvasStoreActions,
  | 'setPlacementPointer'
  | 'beginPlacement'
  | 'commitPlacement'
  | 'setFreeArmed'
  | 'updatePlacementCursor'
  | 'commitFreePlacement'
  | 'cancelPlacement'
  | 'setPlacementHover'
>

export function createPlacementSlice(set: CanvasSet, get: CanvasGet, ctx: CanvasStoreCtx): PlacementActions {
  return {
    setPlacementPointer(point) {
      // Intentionally not via set() — this must not cause re-renders.
      ctx.lastPointerCanvasPos = point
    },

    beginPlacement(panelId, panelType, onCancelled, size) {
      const state = get()
      const nodeSize = size ?? PANEL_DEFAULT_SIZES[panelType]
      // Re-trigger while a placement is pending: latest wins. Roll the previous
      // pending panel back before replacing it so no orphan record lingers.
      const prev = state.pendingPlacement
      if (prev && prev.panelId !== panelId) {
        prev.onCancelled?.(prev.panelId)
      }
      // Empty canvas: there's nothing to place around, so ghost recommendations
      // add a needless choose-a-spot step. Drop the panel straight onto where the
      // camera is looking (the viewport centre) and skip the picker.
      if (Object.keys(state.nodes).length === 0) {
        const cs = state.containerSize
        const center =
          cs.width > 0 && cs.height > 0
            ? viewToCanvasCoords({ x: cs.width / 2, y: cs.height / 2 }, state.zoomLevel, state.viewportOffset)
            : null
        const origin = center
          ? { x: center.x - nodeSize.width / 2, y: center.y - nodeSize.height / 2 }
          : undefined
        const nodeId = get().addNode(panelId, panelType, origin, nodeSize)
        if (!nodeId) return false
        get().focusAndCenter(nodeId)
        return true
      }
      // Dev-only: capture the algorithm's reasoning so the placement-viz overlay
      // (Cmd/Ctrl+Shift+G) can render the REAL spots. Stays undefined in prod, so
      // no object is allocated and the trace path costs nothing.
      const isDev = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV
      const trace: PlacementTrace | undefined = isDev
        ? { area: { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } }, rankAt: { x: 0, y: 0 }, inflated: [], guides: { xs: [], ys: [] }, steps: [] }
        : undefined
      const candidates = recommendPlacements(
        state.nodes,
        focusedNodeId(state),
        panelType,
        { offset: state.viewportOffset, zoom: state.zoomLevel, containerSize: state.containerSize },
        ctx.lastPointerCanvasPos,
        undefined,
        nodeSize,
        trace,
      )
      if (candidates.length === 0) return false

      // Zoom out so every recommendation (plus the focused node for context) is
      // visible at once. Only ever zoom OUT — never further in.
      let nextZoom = state.zoomLevel
      let nextOffset = state.viewportOffset
      const cs = state.containerSize
      if (cs.width > 0 && cs.height > 0) {
        const rects: Rect[] = candidates.map((c) => ({ origin: c.point, size: c.size }))
        const focusedId = focusedNodeId(state)
        const focused = focusedId ? state.nodes[focusedId] : null
        if (focused) rects.push({ origin: focused.origin, size: focused.size })
        const minX = Math.min(...rects.map((r) => r.origin.x))
        const minY = Math.min(...rects.map((r) => r.origin.y))
        const maxX = Math.max(...rects.map((r) => r.origin.x + r.size.width))
        const maxY = Math.max(...rects.map((r) => r.origin.y + r.size.height))
        const padding = 80
        const contentW = maxX - minX + padding * 2
        const contentH = maxY - minY + padding * 2
        const fitZoom = Math.min(cs.width / contentW, cs.height / contentH)
        nextZoom = Math.min(Math.max(Math.min(state.zoomLevel, fitZoom), ZOOM_MIN), ZOOM_MAX)
        nextOffset = {
          x: (cs.width - contentW * nextZoom) / 2 - (minX - padding) * nextZoom,
          y: (cs.height - contentH * nextZoom) / 2 - (minY - padding) * nextZoom,
        }
      }

      set({
        pendingPlacement: {
          panelId,
          panelType,
          candidates,
          hoveredIndex: null,
          freeArmed: false,
          freeGhost: null,
          size: nodeSize,
          trace,
          prevZoom: state.zoomLevel,
          prevOffset: state.viewportOffset,
          onCancelled,
        },
        zoomLevel: nextZoom,
        viewportOffset: nextOffset,
      })
      return true
    },

    commitPlacement(index) {
      const pending = get().pendingPlacement
      if (!pending) return null
      const candidate = pending.candidates[index]
      if (!candidate) return null
      // Restore the pre-placement zoom, drop the ghosts, then create + centre the
      // node at the chosen recommended spot.
      set({ pendingPlacement: null, zoomLevel: pending.prevZoom })
      const nodeId = get().addNode(pending.panelId, pending.panelType, candidate.point, candidate.size)
      if (!nodeId) return null
      get().focusAndCenter(nodeId)
      return nodeId
    },

    setFreeArmed(armed) {
      const pending = get().pendingPlacement
      if (!pending || pending.freeArmed === armed) return
      set({ pendingPlacement: { ...pending, freeArmed: armed, freeGhost: armed ? pending.freeGhost : null } })
    },

    updatePlacementCursor(point) {
      const pending = get().pendingPlacement
      if (!pending) return
      const size = pending.size
      const desired = { x: point.x - size.width / 2, y: point.y - size.height / 2 }
      const p = nudgeToFree(get().nodes, size, desired)
      const cur = pending.freeGhost
      if (cur && cur.point.x === p.x && cur.point.y === p.y) return
      set({ pendingPlacement: { ...pending, freeGhost: { point: p, size } } })
    },

    commitFreePlacement(point) {
      const pending = get().pendingPlacement
      if (!pending) return null
      const size = pending.size
      const desired = { x: point.x - size.width / 2, y: point.y - size.height / 2 }
      const p = nudgeToFree(get().nodes, size, desired)
      set({ pendingPlacement: null, zoomLevel: pending.prevZoom })
      const nodeId = get().addNode(pending.panelId, pending.panelType, p, size)
      if (!nodeId) return null
      get().focusAndCenter(nodeId)
      return nodeId
    },

    cancelPlacement() {
      const pending = get().pendingPlacement
      if (!pending) return
      // Restore the viewport we zoomed out from.
      set({ pendingPlacement: null, zoomLevel: pending.prevZoom, viewportOffset: pending.prevOffset })
      pending.onCancelled?.(pending.panelId)
    },

    setPlacementHover(index) {
      const pending = get().pendingPlacement
      if (!pending || pending.hoveredIndex === index) return
      set({ pendingPlacement: { ...pending, hoveredIndex: index } })
    },
  }
}
