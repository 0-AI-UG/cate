import React from 'react'
import { useCanvasView } from './context'

const COLOR = 'rgba(74, 158, 255, 0.7)'
const EXTENT = 100000

function SnapGuides(): React.ReactElement | null {
  const guides = useCanvasView((s) => s.snapGuides)
  if (guides.lines.length === 0) return null
  return (
    <>
      {guides.lines.map((line, i) => {
        const dashed = line.type === 'center'
        const vertical = line.axis === 'x'
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: vertical ? line.position : -EXTENT / 2,
              top: vertical ? -EXTENT / 2 : line.position,
              width: vertical ? 1 : EXTENT,
              height: vertical ? EXTENT : 1,
              backgroundColor: dashed ? undefined : COLOR,
              backgroundImage: dashed
                ? `repeating-linear-gradient(to ${vertical ? 'bottom' : 'right'}, ${COLOR} 0px, ${COLOR} 6px, transparent 6px, transparent 12px)`
                : undefined,
              pointerEvents: 'none',
            }}
          />
        )
      })}
    </>
  )
}

export default React.memo(SnapGuides)
