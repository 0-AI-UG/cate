// =============================================================================
// Viewport slice — zoom, viewport offset, the zoom/pan animation tweens, and
// canvas<->view coordinate conversion. The rAF handles for the tweens live on
// the per-instance ctx so they stay isolated per store.
// =============================================================================

import { ZOOM_MIN, ZOOM_MAX } from '../../../shared/types'
import { viewToCanvas as viewToCanvasCoords } from '../../lib/canvas/coordinates'
import type { CanvasGet, CanvasSet, CanvasStoreActions } from './storeTypes'
import type { CanvasStoreCtx } from './storeCtx'
import { focusedNodeId } from './selectionModel'

type ViewportActions = Pick<
  CanvasStoreActions,
  | 'cancelZoomAnimation'
  | 'setZoom'
  | 'setViewportOffset'
  | 'setZoomAndOffset'
  | 'setContainerSize'
  | 'zoomAroundCenter'
  | 'animateZoomTo'
  | 'animateViewportTo'
  | 'canvasToView'
  | 'viewToCanvas'
  | 'viewFrame'
  | 'zoomToFit'
  | 'zoomToSelection'
>

export function createViewportSlice(set: CanvasSet, get: CanvasGet, ctx: CanvasStoreCtx): ViewportActions {
  return {
    cancelZoomAnimation: ctx.cancelZoomAnim,

    setZoom(level) {
      const clamped = Math.min(Math.max(level, ZOOM_MIN), ZOOM_MAX)
      set({ zoomLevel: clamped })
    },

    setViewportOffset(offset) {
      // A manual pan (wheel / drag) interrupts any in-flight keyboard tween and
      // resumes auto-focus-largest.
      ctx.cancelOffsetAnim()
      if (get().suppressAutoFocus) set({ viewportOffset: offset, suppressAutoFocus: false })
      else set({ viewportOffset: offset })
    },

    setZoomAndOffset(zoom, offset) {
      const clamped = Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX)
      set({ zoomLevel: clamped, viewportOffset: offset, suppressAutoFocus: false })
    },

    setContainerSize(size) {
      set({ containerSize: size })
    },

    zoomAroundCenter(newZoom) {
      const state = get()
      const clamped = Math.min(Math.max(newZoom, ZOOM_MIN), ZOOM_MAX)
      if (clamped === state.zoomLevel) return
      const cs = state.containerSize
      if (cs.width === 0 || cs.height === 0) {
        // Fallback if container size not yet measured
        set({ zoomLevel: clamped })
        return
      }
      const centerView = { x: cs.width / 2, y: cs.height / 2 }
      const centerCanvas = {
        x: (centerView.x - state.viewportOffset.x) / state.zoomLevel,
        y: (centerView.y - state.viewportOffset.y) / state.zoomLevel,
      }
      set({
        zoomLevel: clamped,
        suppressAutoFocus: false,
        viewportOffset: {
          x: centerView.x - centerCanvas.x * clamped,
          y: centerView.y - centerCanvas.y * clamped,
        },
      })
    },

    animateZoomTo(targetZoom) {
      ctx.cancelZoomAnim()
      ctx.cancelOffsetAnim()
      if (get().suppressAutoFocus) set({ suppressAutoFocus: false })

      const clampedTarget = Math.min(Math.max(targetZoom, ZOOM_MIN), ZOOM_MAX)

      const tick = () => {
        const state = get()
        const diff = clampedTarget - state.zoomLevel

        if (Math.abs(diff) < 0.001) {
          // Snap to exact target
          const centerX = (state.containerSize?.width || window.innerWidth) / 2
          const centerY = (state.containerSize?.height || window.innerHeight) / 2
          const canvasPoint = viewToCanvasCoords({ x: centerX, y: centerY }, state.zoomLevel, state.viewportOffset)
          set({
            zoomLevel: clampedTarget,
            viewportOffset: {
              x: centerX - canvasPoint.x * clampedTarget,
              y: centerY - canvasPoint.y * clampedTarget,
            },
          })
          ctx.activeZoomAnimationRafId = 0
          return
        }

        const newZoom = state.zoomLevel + diff * 0.15
        const centerX = (state.containerSize?.width || window.innerWidth) / 2
        const centerY = (state.containerSize?.height || window.innerHeight) / 2
        const canvasPoint = viewToCanvasCoords({ x: centerX, y: centerY }, state.zoomLevel, state.viewportOffset)
        set({
          zoomLevel: newZoom,
          viewportOffset: {
            x: centerX - canvasPoint.x * newZoom,
            y: centerY - canvasPoint.y * newZoom,
          },
        })

        ctx.activeZoomAnimationRafId = requestAnimationFrame(tick)
      }

      ctx.activeZoomAnimationRafId = requestAnimationFrame(tick)
    },

    animateViewportTo(target) {
      // A pan and a zoom-recentre must not both drive viewportOffset at once.
      ctx.cancelZoomAnim()
      ctx.offsetAnimTarget = target

      // No RAF (e.g. the node test environment) — apply instantly.
      if (typeof requestAnimationFrame !== 'function') {
        ctx.activeOffsetAnimationRafId = 0
        ctx.offsetAnimTarget = null
        set({ viewportOffset: target })
        return
      }

      // A loop is already running — it will glide to the updated target.
      if (ctx.activeOffsetAnimationRafId) return

      const EASE = 0.18
      const tick = () => {
        const t = ctx.offsetAnimTarget
        if (!t) { ctx.activeOffsetAnimationRafId = 0; return }
        const { viewportOffset: o } = get()
        const dx = t.x - o.x
        const dy = t.y - o.y
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
          set({ viewportOffset: { x: t.x, y: t.y } })
          ctx.activeOffsetAnimationRafId = 0
          ctx.offsetAnimTarget = null
          return
        }
        set({ viewportOffset: { x: o.x + dx * EASE, y: o.y + dy * EASE } })
        ctx.activeOffsetAnimationRafId = requestAnimationFrame(tick)
      }
      ctx.activeOffsetAnimationRafId = requestAnimationFrame(tick)
    },

    // --- Derived getters ---

    canvasToView(point) {
      const { zoomLevel, viewportOffset } = get()
      return {
        x: point.x * zoomLevel + viewportOffset.x,
        y: point.y * zoomLevel + viewportOffset.y,
      }
    },

    viewToCanvas(point) {
      const { zoomLevel, viewportOffset } = get()
      return {
        x: (point.x - viewportOffset.x) / zoomLevel,
        y: (point.y - viewportOffset.y) / zoomLevel,
      }
    },

    viewFrame(nodeId) {
      const { nodes, zoomLevel } = get()
      const node = nodes[nodeId]
      if (!node) return null
      const viewOrigin = get().canvasToView(node.origin)
      return {
        origin: viewOrigin,
        size: {
          width: node.size.width * zoomLevel,
          height: node.size.height * zoomLevel,
        },
      }
    },

    zoomToFit() {
      const state = get()
      const nodeList = Object.values(state.nodes)
      if (nodeList.length === 0) return
      const cs = state.containerSize
      if (cs.width === 0 || cs.height === 0) return

      const minX = Math.min(...nodeList.map(n => n.origin.x))
      const minY = Math.min(...nodeList.map(n => n.origin.y))
      const maxX = Math.max(...nodeList.map(n => n.origin.x + n.size.width))
      const maxY = Math.max(...nodeList.map(n => n.origin.y + n.size.height))

      const padding = 60
      const contentW = maxX - minX + padding * 2
      const contentH = maxY - minY + padding * 2
      const zoom = Math.min(Math.max(Math.min(cs.width / contentW, cs.height / contentH), ZOOM_MIN), ZOOM_MAX)

      set({
        zoomLevel: zoom,
        viewportOffset: {
          x: (cs.width - contentW * zoom) / 2 - (minX - padding) * zoom,
          y: (cs.height - contentH * zoom) / 2 - (minY - padding) * zoom,
        },
      })
    },

    zoomToSelection() {
      const state = get()
      const cs = state.containerSize
      if (cs.width === 0 || cs.height === 0) return

      // Target the selection, else the focused node, else fall back to fit-all.
      let target = Object.values(state.nodes).filter((n) => state.selection.includes(n.id))
      if (target.length === 0) {
        const focusedId = focusedNodeId(state)
        const focused = focusedId ? state.nodes[focusedId] : null
        if (focused) target = [focused]
      }
      if (target.length === 0) {
        get().zoomToFit()
        return
      }

      const minX = Math.min(...target.map(n => n.origin.x))
      const minY = Math.min(...target.map(n => n.origin.y))
      const maxX = Math.max(...target.map(n => n.origin.x + n.size.width))
      const maxY = Math.max(...target.map(n => n.origin.y + n.size.height))

      const padding = 60
      const contentW = maxX - minX + padding * 2
      const contentH = maxY - minY + padding * 2
      // Cap a single-node target so we don't over-zoom a small panel.
      const fitZoom = Math.min(cs.width / contentW, cs.height / contentH)
      const maxZoom = target.length === 1 ? Math.min(ZOOM_MAX, 1.5) : ZOOM_MAX
      const zoom = Math.min(Math.max(fitZoom, ZOOM_MIN), maxZoom)

      set({
        zoomLevel: zoom,
        viewportOffset: {
          x: (cs.width - contentW * zoom) / 2 - (minX - padding) * zoom,
          y: (cs.height - contentH * zoom) / 2 - (minY - padding) * zoom,
        },
      })
    },
  }
}
