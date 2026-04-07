// =============================================================================
// CanvasGrid — SVG grid overlay rendered behind canvas nodes.
// Ported from CanvasView.swift drawGrid() method.
// =============================================================================

import React, { useMemo } from 'react'
import { useCanvasStoreContext } from '../stores/CanvasStoreContext'
import { useSettingsStore } from '../stores/settingsStore'

interface CanvasGridProps {
  containerWidth: number
  containerHeight: number
}

const CanvasGrid: React.FC<CanvasGridProps> = ({
  containerWidth,
  containerHeight,
}) => {
  const gridStyle = useSettingsStore((s) => s.gridStyle)
  const gridSpacing = useSettingsStore((s) => s.gridSpacing)
  const zoom = useCanvasStoreContext((s) => s.zoomLevel)
  const offset = useCanvasStoreContext((s) => s.viewportOffset)

  // Compute the visible canvas rect from the viewport
  const visibleRect = useMemo(() => {
    return {
      left: -offset.x / zoom,
      top: -offset.y / zoom,
      right: (-offset.x + containerWidth) / zoom,
      bottom: (-offset.y + containerHeight) / zoom,
    }
  }, [offset.x, offset.y, zoom, containerWidth, containerHeight])

  // Snap visible bounds to grid boundaries (with some padding)
  const gridBounds = useMemo(() => {
    const startX = Math.floor(visibleRect.left / gridSpacing) * gridSpacing
    const startY = Math.floor(visibleRect.top / gridSpacing) * gridSpacing
    const endX = Math.ceil(visibleRect.right / gridSpacing) * gridSpacing
    const endY = Math.ceil(visibleRect.bottom / gridSpacing) * gridSpacing
    return { startX, startY, endX, endY }
  }, [visibleRect, gridSpacing])

  if (gridStyle === 'blank') {
    return null
  }

  const { startX, startY, endX, endY } = gridBounds
  const gridWidth = endX - startX
  const gridHeight = endY - startY

  if (gridStyle === 'dots') {
    return (
      <svg
        style={{
          position: 'absolute',
          left: startX,
          top: startY,
          width: gridWidth,
          height: gridHeight,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      >
        <defs>
          <pattern
            id="grid-dots"
            x={0}
            y={0}
            width={gridSpacing}
            height={gridSpacing}
            patternUnits="userSpaceOnUse"
          >
            <circle
              cx={0}
              cy={0}
              r={1}
              fill="rgba(255, 255, 255, 0.15)"
            />
          </pattern>
        </defs>
        <rect
          x={0}
          y={0}
          width={gridWidth}
          height={gridHeight}
          fill="url(#grid-dots)"
        />
      </svg>
    )
  }

  // gridStyle === 'lines'
  return (
    <svg
      style={{
        position: 'absolute',
        left: startX,
        top: startY,
        width: gridWidth,
        height: gridHeight,
        pointerEvents: 'none',
        zIndex: 0,
      }}
    >
      <defs>
        <pattern
          id="grid-lines"
          x={0}
          y={0}
          width={gridSpacing}
          height={gridSpacing}
          patternUnits="userSpaceOnUse"
        >
          <line
            x1={0}
            y1={0}
            x2={0}
            y2={gridSpacing}
            stroke="rgba(255, 255, 255, 0.06)"
            strokeWidth={0.5}
          />
          <line
            x1={0}
            y1={0}
            x2={gridSpacing}
            y2={0}
            stroke="rgba(255, 255, 255, 0.06)"
            strokeWidth={0.5}
          />
        </pattern>
      </defs>
      <rect
        x={0}
        y={0}
        width={gridWidth}
        height={gridHeight}
        fill="url(#grid-lines)"
      />
    </svg>
  )
}

export default React.memo(CanvasGrid)
