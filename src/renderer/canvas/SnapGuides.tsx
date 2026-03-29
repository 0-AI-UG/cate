import React from 'react'
import { useCanvasStore } from '../stores/canvasStore'

const SnapGuides: React.FC = () => {
  const guides = useCanvasStore((s) => s.snapGuides)
  if (guides.lines.length === 0) return null

  const color = 'rgba(74, 158, 255, 0.7)'
  const extent = 100000

  return (
    <>
      {guides.lines.map((line, i) => {
        const isDashed = line.type === 'center'
        if (line.axis === 'x') {
          // Vertical rule at canvas-space x position
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: line.position,
                top: -extent / 2,
                width: 1,
                height: extent,
                backgroundColor: isDashed ? undefined : color,
                backgroundImage: isDashed
                  ? `repeating-linear-gradient(to bottom, ${color} 0px, ${color} 6px, transparent 6px, transparent 12px)`
                  : undefined,
                pointerEvents: 'none',
              }}
            />
          )
        } else {
          // Horizontal rule at canvas-space y position
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: -extent / 2,
                top: line.position,
                width: extent,
                height: 1,
                backgroundColor: isDashed ? undefined : color,
                backgroundImage: isDashed
                  ? `repeating-linear-gradient(to right, ${color} 0px, ${color} 6px, transparent 6px, transparent 12px)`
                  : undefined,
                pointerEvents: 'none',
              }}
            />
          )
        }
      })}
    </>
  )
}

export default React.memo(SnapGuides)
