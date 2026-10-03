// With `autoFocusLargestVisibleNode` on, focus follows the node covering the
// most of the viewport as the user pans and zooms. Debounced and rAF-batched.

import { useEffect } from 'react'
import type { NodeId } from '@workspace/document/contract'
import type { CanvasViewStore } from './store'
import { focusedNodeId } from './selection'
import { useCanvasSetting } from './settingsHooks'

/** Below this share of the viewport a node cannot claim focus, so a sliver
 *  peeking in does not flicker it. */
const MIN_COVERAGE = 0.01
/** Quiet time after the last pan, zoom or node change before recomputing. */
const DEBOUNCE_MS = 120

export function useAutoFocusLargestVisible(store: CanvasViewStore): void {
  const enabled = useCanvasSetting('autoFocusLargestVisibleNode')

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let raf: number | null = null
    let disposed = false
    // The id this hook focused last, to tell its own focus changes from clicks.
    let autoSetId: NodeId | null = null
    // A clicked node holds focus until it no longer covers enough to claim it.
    let overrideId: NodeId | null = null

    const compute = () => {
      raf = null
      if (disposed) return
      const s = store.getState()
      const { nodes, viewportOffset, zoomLevel, containerSize } = s
      // Keyboard movement selects without activating on purpose.
      if (s.suppressAutoFocus) return
      // Focusing collapses the selection; leave a multi-selection alone.
      if (s.selection.length > 1) return
      if (containerSize.width <= 0 || containerSize.height <= 0 || zoomLevel <= 0) return

      const left = -viewportOffset.x / zoomLevel
      const top = -viewportOffset.y / zoomLevel
      const width = containerSize.width / zoomLevel
      const height = containerSize.height / zoomLevel
      const right = left + width
      const bottom = top + height
      const viewArea = width * height
      if (viewArea <= 0) return

      let bestId: NodeId | null = null
      let bestArea = 0
      let overrideArea = 0
      let overrideExists = false
      for (const id in nodes) {
        const n = nodes[id]
        if (!n || n.animationState === 'exiting') continue
        if (id === overrideId) overrideExists = true
        const ix = Math.max(n.origin.x, left)
        const iy = Math.max(n.origin.y, top)
        const iw = Math.min(n.origin.x + n.size.width, right) - ix
        const ih = Math.min(n.origin.y + n.size.height, bottom) - iy
        if (iw <= 0 || ih <= 0) continue
        const area = iw * ih
        if (id === overrideId) overrideArea = area
        if (area > bestArea) {
          bestArea = area
          bestId = id
        }
      }

      if (overrideId) {
        if (!overrideExists || overrideArea < viewArea * MIN_COVERAGE) overrideId = null
        else return
      }
      if (!bestId || bestArea < viewArea * MIN_COVERAGE) return
      if (bestId === focusedNodeId(s)) return
      autoSetId = bestId
      store.getState().focusNode(bestId)
    }

    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (raf != null) cancelAnimationFrame(raf)
        raf = requestAnimationFrame(compute)
      }, DEBOUNCE_MS)
    }

    let prevFocused = focusedNodeId(store.getState())
    const unsubscribe = store.subscribe((s, prev) => {
      const focused = focusedNodeId(s)
      if (focused !== prevFocused) {
        if (focused && focused !== autoSetId) overrideId = focused
        prevFocused = focused
      }
      if (s.viewportOffset !== prev.viewportOffset || s.zoomLevel !== prev.zoomLevel || s.nodes !== prev.nodes || s.containerSize !== prev.containerSize) {
        schedule()
      }
    })
    schedule()
    return () => {
      disposed = true
      unsubscribe()
      if (timer) clearTimeout(timer)
      if (raf != null) cancelAnimationFrame(raf)
    }
  }, [enabled, store])
}
