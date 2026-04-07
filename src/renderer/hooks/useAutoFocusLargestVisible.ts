// =============================================================================
// useAutoFocusLargestVisible — when the matching setting is enabled, keep focus
// on the canvas node that occupies the most visible area of the viewport as the
// user pans and zooms. Debounced + rAF-batched so it has negligible cost.
// =============================================================================

import { useEffect } from 'react'
import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../stores/canvasStore'
import { useSettingsStore } from '../stores/settingsStore'

/** Minimum fraction of the viewport a node must cover before it can claim
 *  focus. Prevents flicker when a tiny sliver of a panel peeks into view. */
const MIN_COVERAGE_FRACTION = 0.01

/** Debounce window after the last pan/zoom/node mutation before recomputing.
 *  Short enough to feel responsive, long enough that continuous panning or
 *  drags don't cause per-frame focus churn. */
const RECOMPUTE_DEBOUNCE_MS = 120

export function useAutoFocusLargestVisible(canvasApi: StoreApi<CanvasStore>): void {
  const enabled = useSettingsStore((s) => s.autoFocusLargestVisibleNode)

  useEffect(() => {
    if (!enabled) return

    let debounceTimer: number | null = null
    let rafId: number | null = null
    let disposed = false

    const compute = (): void => {
      rafId = null
      if (disposed) return

      const state = canvasApi.getState()
      const { nodes, viewportOffset, zoomLevel, containerSize, focusedNodeId } = state
      if (containerSize.width <= 0 || containerSize.height <= 0) return
      if (zoomLevel <= 0) return

      // Visible viewport rectangle, expressed in canvas coordinates.
      const viewLeft = -viewportOffset.x / zoomLevel
      const viewTop = -viewportOffset.y / zoomLevel
      const viewWidth = containerSize.width / zoomLevel
      const viewHeight = containerSize.height / zoomLevel
      const viewRight = viewLeft + viewWidth
      const viewBottom = viewTop + viewHeight
      const viewArea = viewWidth * viewHeight
      if (viewArea <= 0) return

      let bestId: string | null = null
      let bestArea = 0

      // Cheap loop: avoid allocating Object.values() on every tick.
      for (const id in nodes) {
        const n = nodes[id]
        if (!n) continue
        // Ignore nodes that are on their way out so we don't briefly focus
        // a panel that is already unmounting.
        if (n.animationState === 'exiting') continue

        const nLeft = n.origin.x
        const nTop = n.origin.y
        const nRight = nLeft + n.size.width
        const nBottom = nTop + n.size.height

        const ix = nLeft > viewLeft ? nLeft : viewLeft
        const iy = nTop > viewTop ? nTop : viewTop
        const ir = nRight < viewRight ? nRight : viewRight
        const ib = nBottom < viewBottom ? nBottom : viewBottom
        const iw = ir - ix
        const ih = ib - iy
        if (iw <= 0 || ih <= 0) continue

        const area = iw * ih
        if (area > bestArea) {
          bestArea = area
          bestId = id
        }
      }

      if (!bestId) return
      if (bestArea < viewArea * MIN_COVERAGE_FRACTION) return
      if (bestId === focusedNodeId) return

      canvasApi.getState().focusNode(bestId)
    }

    const schedule = (): void => {
      if (debounceTimer != null) window.clearTimeout(debounceTimer)
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null
        if (rafId != null) cancelAnimationFrame(rafId)
        rafId = requestAnimationFrame(compute)
      }, RECOMPUTE_DEBOUNCE_MS)
    }

    // Track only the slices that can change the "largest visible" answer.
    // Comparing by reference works because the store replaces these on write.
    const seed = canvasApi.getState()
    let prevOffset = seed.viewportOffset
    let prevZoom = seed.zoomLevel
    let prevNodes = seed.nodes
    let prevSize = seed.containerSize

    const unsubscribe = canvasApi.subscribe((s) => {
      if (
        s.viewportOffset !== prevOffset ||
        s.zoomLevel !== prevZoom ||
        s.nodes !== prevNodes ||
        s.containerSize !== prevSize
      ) {
        prevOffset = s.viewportOffset
        prevZoom = s.zoomLevel
        prevNodes = s.nodes
        prevSize = s.containerSize
        schedule()
      }
    })

    // Run once on mount so toggling the setting on takes effect immediately.
    schedule()

    return () => {
      disposed = true
      unsubscribe()
      if (debounceTimer != null) window.clearTimeout(debounceTimer)
      if (rafId != null) cancelAnimationFrame(rafId)
    }
  }, [enabled, canvasApi])
}
