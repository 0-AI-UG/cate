// Screen-space grid (dots or lines) drawn as a CSS background outside the
// world transform, so it lands on whole device pixels at every zoom. The step
// is BASE_SPACING * zoom; background-position slides with the pan. The offset
// is applied imperatively, so panning never re-renders this component.

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

  useEffect(() => {
    const apply = (x: number, y: number) => {
      if (divRef.current) divRef.current.style.backgroundPosition = `${x}px ${y}px`
    }
    const { viewportOffset } = canvasApi.getState()
    apply(viewportOffset.x, viewportOffset.y)
    return canvasApi.subscribe((state, prev) => {
      if (state.viewportOffset !== prev.viewportOffset) apply(state.viewportOffset.x, state.viewportOffset.y)
    })
  }, [canvasApi, zoom])

  if (style === 'none') return null

  // Zoomed out, double the spacing until the on-screen step stays readable.
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
      data-canvas-grid
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
