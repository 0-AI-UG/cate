// =============================================================================
// Panel target slice — the single interactive transaction for choosing a new
// panel position, an existing panel, or either.
// =============================================================================

import type { CanvasNodeId, PanelType, Point, Rect, Size } from '../../../shared/types'
import { PANEL_DEFAULT_SIZES, ZOOM_MAX, ZOOM_MIN } from '../../../shared/types'
import { collectPanelIds } from '../../../shared/collectPanelIds'
import { viewToCanvas as viewToCanvasCoords } from '../../lib/canvas/coordinates'
import {
  nudgeToFree,
  recommendPlacements,
  type PlacementCandidate,
} from '../../canvas/placement'
import type {
  CanvasGet,
  CanvasSet,
  CanvasStoreActions,
  CanvasStoreState,
  PendingPanelTarget,
} from './storeTypes'
import type { CanvasStoreCtx } from './storeCtx'
import { focusedNodeId } from './selectionModel'

type PanelTargetActions = Pick<
  CanvasStoreActions,
  | 'setPlacementPointer'
  | 'refreshPlacement'
  | 'setFreeArmed'
  | 'updatePlacementCursor'
  | 'commitFreePlacement'
  | 'setPlacementHover'
  | 'beginPanelTarget'
  | 'selectNewPanelTarget'
  | 'selectExistingPanelTarget'
  | 'cancelPanelTarget'
>

function computeCandidates(
  state: CanvasStoreState,
  ctx: CanvasStoreCtx,
  panelType: PanelType,
  size: Size,
): PlacementCandidate[] {
  return recommendPlacements(
    state.nodes,
    focusedNodeId(state),
    panelType,
    { offset: state.viewportOffset, zoom: state.zoomLevel, containerSize: state.containerSize },
    ctx.lastPointerCanvasPos,
    undefined,
    size,
  )
}

function existingRects(state: CanvasStoreState, pending: PendingPanelTarget): Rect[] {
  return [...new Set(pending.existing.map((candidate) => candidate.nodeId))].flatMap((nodeId) => {
    const node = state.nodes[nodeId]
    return node ? [{ origin: node.origin, size: node.size }] : []
  })
}

function fitCamera(
  state: CanvasStoreState,
  candidates: PlacementCandidate[],
  existing: Rect[],
): { zoom: number; offset: Point } {
  const rects: Rect[] = [
    ...candidates.map((candidate) => ({ origin: candidate.point, size: candidate.size })),
    ...existing,
  ]
  if (candidates.length > 0) {
    const focusedId = focusedNodeId(state)
    const focused = focusedId ? state.nodes[focusedId] : null
    if (focused) rects.push({ origin: focused.origin, size: focused.size })
  }
  if (rects.length === 0 || state.containerSize.width <= 0 || state.containerSize.height <= 0) {
    return { zoom: state.zoomLevel, offset: state.viewportOffset }
  }

  const minX = Math.min(...rects.map((rect) => rect.origin.x))
  const minY = Math.min(...rects.map((rect) => rect.origin.y))
  const maxX = Math.max(...rects.map((rect) => rect.origin.x + rect.size.width))
  const maxY = Math.max(...rects.map((rect) => rect.origin.y + rect.size.height))
  const padding = 80
  const width = maxX - minX + padding * 2
  const height = maxY - minY + padding * 2
  const fit = Math.min(state.containerSize.width / width, state.containerSize.height / height)
  const zoom = Math.min(Math.max(Math.min(state.zoomLevel, fit), ZOOM_MIN), ZOOM_MAX)
  return {
    zoom,
    offset: {
      x: (state.containerSize.width - width * zoom) / 2 - (minX - padding) * zoom,
      y: (state.containerSize.height - height * zoom) / 2 - (minY - padding) * zoom,
    },
  }
}

export function createPanelTargetSlice(
  set: CanvasSet,
  get: CanvasGet,
  ctx: CanvasStoreCtx,
): PanelTargetActions {
  const beginTarget = (
    request: Parameters<CanvasStoreActions['beginPanelTarget']>[0],
  ): boolean => {
    const state = get()
    const size = request.size ?? PANEL_DEFAULT_SIZES[request.panelType]
    const allowNew = request.availability !== 'existing'
    const allowExisting = request.availability !== 'new'
    const candidates = allowNew
      ? computeCandidates(state, ctx, request.panelType, size)
      : []
    const existing = allowExisting
      ? request.existing.flatMap((candidate) => {
          const node = Object.values(state.nodes).find((item) =>
            collectPanelIds(item.dockLayout).includes(candidate.panelId),
          )
          return node ? [{ ...candidate, nodeId: node.id }] : []
        })
      : []
    if (candidates.length === 0 && existing.length === 0) return false

    const pending: PendingPanelTarget = {
      panelId: request.panelId,
      panelType: request.panelType,
      availability: request.availability,
      candidates,
      existing,
      hoveredIndex: null,
      freeArmed: false,
      freeGhost: null,
      size,
      prevZoom: state.zoomLevel,
      prevOffset: state.viewportOffset,
      onSelected: request.onSelected,
      onCancelled: request.onCancelled,
    }
    const camera = fitCamera(state, candidates, existingRects(state, pending))
    set({
      pendingPanelTarget: pending,
      zoomLevel: camera.zoom,
      viewportOffset: camera.offset,
    })
    return true
  }

  const finishNewTarget = (
    pending: PendingPanelTarget,
    point: Point,
    size: Size,
  ): CanvasNodeId | null => {
    if (pending.panelId) {
      set({ pendingPanelTarget: null, zoomLevel: pending.prevZoom })
      const nodeId = get().addNode(pending.panelId, pending.panelType, point, size)
      if (!nodeId) return null
      get().focusAndCenter(nodeId)
      return nodeId
    }
    set({
      pendingPanelTarget: null,
      zoomLevel: pending.prevZoom,
      viewportOffset: pending.prevOffset,
    })
    pending.onSelected?.({ kind: 'new', point, size })
    return null
  }

  return {
    setPlacementPointer(point) {
      ctx.lastPointerCanvasPos = point
    },

    beginPanelTarget(request) {
      const previous = get().pendingPanelTarget
      if (previous) {
        set({
          pendingPanelTarget: null,
          zoomLevel: previous.prevZoom,
          viewportOffset: previous.prevOffset,
        })
        if (!request.panelId || previous.panelId !== request.panelId) previous.onCancelled()
      }
      const state = get()
      const nodeSize = request.size ?? PANEL_DEFAULT_SIZES[request.panelType]
      if (
        request.panelId
        && request.availability === 'new'
        && Object.keys(state.nodes).length === 0
      ) {
        const cs = state.containerSize
        const center = cs.width > 0 && cs.height > 0
          ? viewToCanvasCoords(
              { x: cs.width / 2, y: cs.height / 2 },
              state.zoomLevel,
              state.viewportOffset,
            )
          : null
        const origin = center
          ? { x: center.x - nodeSize.width / 2, y: center.y - nodeSize.height / 2 }
          : undefined
        const nodeId = get().addNode(request.panelId, request.panelType, origin, nodeSize)
        if (!nodeId) return false
        get().focusAndCenter(nodeId)
        return true
      }
      return beginTarget({ ...request, size: nodeSize })
    },

    refreshPlacement() {
      const state = get()
      const pending = state.pendingPanelTarget
      if (!pending || pending.freeArmed || pending.availability === 'existing') return
      const candidates = computeCandidates(state, ctx, pending.panelType, pending.size)
      if (candidates.length === 0) return
      const camera = fitCamera(state, candidates, existingRects(state, pending))
      set({
        pendingPanelTarget: { ...pending, candidates, hoveredIndex: null },
        zoomLevel: camera.zoom,
        viewportOffset: camera.offset,
      })
    },

    selectNewPanelTarget(index) {
      const pending = get().pendingPanelTarget
      const candidate = pending?.candidates[index]
      if (!pending || !candidate) return null
      return finishNewTarget(pending, candidate.point, candidate.size)
    },

    selectExistingPanelTarget(panelId) {
      const pending = get().pendingPanelTarget
      if (!pending?.existing.some((candidate) => candidate.panelId === panelId)) return
      set({
        pendingPanelTarget: null,
        zoomLevel: pending.prevZoom,
        viewportOffset: pending.prevOffset,
      })
      pending.onSelected?.({ kind: 'existing', panelId })
    },

    setFreeArmed(armed) {
      const pending = get().pendingPanelTarget
      if (!pending || pending.availability === 'existing' || pending.freeArmed === armed) return
      set({
        pendingPanelTarget: {
          ...pending,
          freeArmed: armed,
          freeGhost: armed ? pending.freeGhost : null,
        },
      })
    },

    updatePlacementCursor(point) {
      const pending = get().pendingPanelTarget
      if (!pending || pending.availability === 'existing') return
      const desired = {
        x: point.x - pending.size.width / 2,
        y: point.y - pending.size.height / 2,
      }
      const placed = nudgeToFree(get().nodes, pending.size, desired)
      const current = pending.freeGhost
      if (current && current.point.x === placed.x && current.point.y === placed.y) return
      set({
        pendingPanelTarget: {
          ...pending,
          freeGhost: { point: placed, size: pending.size },
        },
      })
    },

    commitFreePlacement(point) {
      const pending = get().pendingPanelTarget
      if (!pending || pending.availability === 'existing') return null
      const desired = {
        x: point.x - pending.size.width / 2,
        y: point.y - pending.size.height / 2,
      }
      const placed = nudgeToFree(get().nodes, pending.size, desired)
      return finishNewTarget(pending, placed, pending.size)
    },

    cancelPanelTarget() {
      const pending = get().pendingPanelTarget
      if (!pending) return
      set({
        pendingPanelTarget: null,
        zoomLevel: pending.prevZoom,
        viewportOffset: pending.prevOffset,
      })
      pending.onCancelled()
    },

    setPlacementHover(index) {
      const pending = get().pendingPanelTarget
      if (!pending || pending.hoveredIndex === index) return
      set({ pendingPanelTarget: { ...pending, hoveredIndex: index } })
    },
  }
}
