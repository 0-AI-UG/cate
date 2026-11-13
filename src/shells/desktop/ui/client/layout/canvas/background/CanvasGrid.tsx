// Screen-space grid (dots or lines) drawn as a CSS background outside the
// world transform, so it lands on whole device pixels at every zoom. The step
// is BASE_SPACING * zoom. Slide a cached grid layer by at most one repeat in
// either direction, so panning does not repaint the full viewport gradient.

import React, { useEffect, useRef } from 'react'
import { CANVAS_GRID_SIZE } from '@workspace/canvas/contract'
import { useCanvasSetting } from '../settingsHooks'
import { useCanvasView, useCanvasViewStore } from '../context'

interface CanvasGridProps {
  containerWidth: number
  containerHeight: number
}

const BASE_SPACING = CANVAS_GRID_SIZE
const MIN_SCREEN_STEP = 16

function CanvasGrid({ containerWidth, containerHeight }: CanvasGridProps) {
  const zoom = useCanvasView((s) => s.zoomLevel)
  const canvasApi = useCanvasViewStore()
  const style = useCanvasSetting('canvasGridStyle')
  const divRef = useRef<HTMLDivElement>(null)

  // Zoomed out, double the spacing until the on-screen step stays readable.
  let canvasStep = BASE_SPACING
  while (canvasStep * zoom < MIN_SCREEN_STEP) canvasStep *= 2
  // Blink sizes background repeats in 1/64 CSS pixels. Wrap by the painted
  // period too, or a large offset drifts at fractional zoom levels.
  const step = Math.floor(Math.fround(canvasStep * zoom) * 64) / 64

  useEffect(() => {
    const apply = (x: number, y: number) => {
      if (divRef.current) divRef.current.style.transform = `translate(${x % step}px, ${y % step}px)`
    }
    const { viewportOffset } = canvasApi.getState()
    apply(viewportOffset.x, viewportOffset.y)
    return canvasApi.subscribe((state, prev) => {
      if (state.viewportOffset !== prev.viewportOffset) apply(state.viewportOffset.x, state.viewportOffset.y)
    })
  }, [canvasApi, step])

  if (style === 'none') return null

  const initialOffset = canvasApi.getState().viewportOffset

  const backgroundImage =
    style === 'lines'
      ? `linear-gradient(to right, var(--grid-line) 1px, transparent 1px), linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)`
      : `radial-gradient(circle, var(--grid-dot) 1px, transparent 1px)`

  return (
    <div
      ref={divRef}
      data-canvas-grid
      style={{
        position: 'absolute',
        left: -step,
        top: -step,
        width: containerWidth + 2 * step,
        height: containerHeight + 2 * step,
        pointerEvents: 'none',
        zIndex: 0,
        backgroundImage,
        backgroundSize: `${step}px ${step}px`,
        transform: `translate(${initialOffset.x % step}px, ${initialOffset.y % step}px)`,
        willChange: 'transform',
      }}
    />
  )
}

export default React.memo(CanvasGrid)
