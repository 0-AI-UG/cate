// =============================================================================
// CanvasGrid — screen-space CSS-background grid (dots or lines).
//
// Renders OUTSIDE the world's transform so the pattern always lands on whole
// device pixels and looks identical at every zoom level. The pattern step is
// computed in screen px (BASE_SPACING * zoom), and background-position slides
// the pattern with the pan offset.
//
// Performance: viewportOffset is subscribed imperatively (no React re-render
// during pan). Only zoom/style/container changes trigger re-render.
// =============================================================================

import React, { useRef, useEffect } from 'react'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useSettingsStore } from '../stores/settingsStore'
import { CANVAS_GRID_SIZE } from './layoutEngine'

interface CanvasGridProps {
  containerWidth: number
  containerHeight: number
}

const BASE_SPACING = CANVAS_GRID_SIZE

const CanvasGrid: React.FC<CanvasGridProps> = ({
  containerWidth,
  containerHeight,
}) => {
  const zoom = useCanvasStoreContext((s) => s.zoomLevel)
  const canvasApi = useCanvasStoreApi()
  const style = useSettingsStore((s) => s.canvasGridStyle)

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

  if (style === 'none') return null

  // LOD: when zoomed out, the on-screen step would get too small. Double the
  // canvas-space spacing until the screen step is comfortably readable.
  const MIN_SCREEN_STEP = 16
  let canvasStep = BASE_SPACING
  while (canvasStep * zoom < MIN_SCREEN_STEP) canvasStep *= 2
  const step = canvasStep * zoom
  const initialOffset = canvasApi.getState().viewportOffset

  const backgroundImage =
    style === 'lines'
      ? `linear-gradient(to right, var(--grid-line) 1px, transparent 1px), linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)`
      : `radial-gradient(circle, var(--grid-dot) 1px, transparent 1px)`

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
        backgroundImage,
        backgroundSize: `${step}px ${step}px`,
        backgroundPosition: `${initialOffset.x}px ${initialOffset.y}px`,
      }}
    />
  )
}

export default React.memo(CanvasGrid)
