// The drawing panel's view: its strokes, drawn without panel chrome
// (frameless) and stretched to the node, so resizing the node scales them.
// A press and drag moves it; while it is focused (and the draw tool is put
// away) a dashed outline shows its box.

import { useMemo } from 'react'
import { drawingFrame, drawingStrokes } from '@panels/drawing/contract'
import type { PanelViewProps } from '../../client/host/views'
import { useCanvasNodeFrame, useCanvasUi } from '../../client/layout/canvas'
import { StrokeShape } from './StrokeShape'

export default function DrawingView({ record, focused }: PanelViewProps) {
  const frame = useCanvasNodeFrame()
  const drawing = useCanvasUi((s) => s.activeTool === 'draw')
  const strokes = useMemo(() => drawingStrokes(record), [record])
  const space = drawingFrame(record) ?? { width: 1, height: 1 }

  return (
    <div
      data-drawing
      className={`h-full w-full rounded-md ${focused && !drawing ? 'outline-dashed outline-2 outline-offset-2 outline-focus-blue' : ''}`}
      onMouseDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        frame?.startDrag(event)
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${space.width} ${space.height}`}
        preserveAspectRatio="none"
        className="block overflow-visible"
      >
        {strokes.map((stroke, i) => <StrokeShape key={i} stroke={stroke} />)}
      </svg>
    </div>
  )
}
