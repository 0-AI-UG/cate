// =============================================================================
// CanvasGrid — screen-space CSS-background dot grid.
//
// Renders OUTSIDE the world's transform so dots always land on whole device
// pixels and look identical at every zoom level. The pattern step is computed
// in screen px (BASE_SPACING * zoom), and we use background-position to slide
// the pattern with the pan offset.
//
// Performance: viewportOffset is subscribed imperatively (no React re-render
// during pan). Only zoom/container changes trigger re-render.
// =============================================================================

import React, { useRef, useEffect } from 'react'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'

interface CanvasGridProps {
  containerWidth: number
  containerHeight: number
}

// Fixed canvas-space spacing for the dot pattern. No user setting — the grid
// is purely decorative and snapping was removed, so a single value is fine.
const BASE_SPACING = 20

const CanvasGrid: React.FC<CanvasGridProps> = ({
  containerWidth,
  containerHeight,
}) => {
  const zoom = useCanvasStoreContext((s) => s.zoomLevel)
  const canvasApi = useCanvasStoreApi()

  const divRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const apply = (offsetX: number, offsetY: number) => {
      const el = divRef.current
      if (!el) return
      el.style.backgroundPosition = `${offsetX}px ${offsetY}px`
    }
    const { viewportOffset } = canvasApi.getState()
    apply(viewportOffset.x, viewportOffset.y)
    const unsubscribe = canvasApi.subscribe((state, prev) => {
      if (state.viewportOffset !== prev.viewportOffset) {
        apply(state.viewportOffset.x, state.viewportOffset.y)
      }
    })
    return unsubscribe
  }, [canvasApi, zoom])

  // LOD: when zoomed out, the on-screen step would get too small and the dots
  // crowd into moiré. Double the canvas-space spacing until the screen step
  // is comfortably readable.
  const MIN_SCREEN_STEP = 16
  let canvasStep = BASE_SPACING
  while (canvasStep * zoom < MIN_SCREEN_STEP) canvasStep *= 2
  const step = canvasStep * zoom
  const initialOffset = canvasApi.getState().viewportOffset

  return (
    <div
      ref={divRef}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: containerWidth,
        height: containerHeight,
        pointerEvents: 'none',
        zIndex: 0,
        backgroundImage: `radial-gradient(circle, var(--grid-dot) 1px, transparent 1px)`,
        backgroundSize: `${step}px ${step}px`,
        backgroundPosition: `${initialOffset.x}px ${initialOffset.y}px`,
      }}
    />
  )
}

export default React.memo(CanvasGrid)
