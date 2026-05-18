// =============================================================================
// CanvasDrawings — renders freehand pen strokes inside the world transform.
// Strokes are stored in canvas-space, so they pan/zoom with the canvas.
// Click a stroke to select it (or click-drag to move it). Delete/Backspace
// removes the selected stroke. Right-click opens a color/size context menu.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react'
import { useCanvasStoreContext, useCanvasStoreApi, shallow } from '../stores/CanvasStoreContext'
import type { CanvasDrawing } from '../../shared/types'
import type { NativeContextMenuItem } from '../../shared/electron-api'

// Color palette for the right-click "Stroke Color" submenu. Matches the rest
// of the canvas annotations' palette so all canvas marks feel consistent.
const STROKE_COLORS: Array<{ label: string; value: string }> = [
  { label: 'Red', value: 'rgba(255,90,90,0.95)' },
  { label: 'Orange', value: 'rgba(255,165,80,0.95)' },
  { label: 'Yellow', value: 'rgba(255,221,87,0.95)' },
  { label: 'Green', value: 'rgba(134,219,143,0.95)' },
  { label: 'Blue', value: 'rgba(138,180,248,0.95)' },
  { label: 'Purple', value: 'rgba(197,167,233,0.95)' },
  { label: 'White', value: 'rgba(240,240,240,0.95)' },
  { label: 'Black', value: 'rgba(20,20,20,0.95)' },
]

function pointsToPath(points: CanvasDrawing['points']): string {
  if (points.length === 0) return ''
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length; i++) d += ` L ${points[i].x} ${points[i].y}`
  return d
}

function boundsOf(points: CanvasDrawing['points']): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

const Stroke: React.FC<{ drawing: CanvasDrawing; selected: boolean }> = React.memo(({ drawing, selected }) => {
  const canvasApi = useCanvasStoreApi()
  // Live translation during drag — applied as an SVG transform on the inner
  // group so we don't churn the store on every mousemove. Committed to the
  // store on mouseup via moveDrawing(delta).
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const dragStartRef = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  // Track drag listeners so a context-menu open can abort them — otherwise a
  // mouseup that lands on the native menu never reaches the window and the
  // stroke stays glued to the cursor.
  const dragAbortRef = useRef<AbortController | null>(null)

  useEffect(() => () => { dragAbortRef.current?.abort() }, [])

  const b = boundsOf(drawing.points)
  // Pad so wide strokes (and the selection halo) aren't clipped by the SVG viewBox.
  const pad = Math.max(12, drawing.strokeWidth * 3)

  const onPointerDown = (e: React.MouseEvent) => {
    // Always stop propagation so a right-click on the stroke doesn't trigger
    // canvas right-click panning beneath us (which the native context menu
    // would otherwise leave stuck because it eats the mouseup).
    e.stopPropagation()
    if (e.button !== 0) return
    // Select on press so a no-drag click leaves the stroke selected.
    canvasApi.getState().selectDrawing(drawing.id)
    dragStartRef.current = { x: e.clientX, y: e.clientY, moved: false }
    const onMove = (ev: MouseEvent) => {
      const s = dragStartRef.current
      if (!s) return
      const zoom = canvasApi.getState().zoomLevel
      const rawDx = ev.clientX - s.x
      const rawDy = ev.clientY - s.y
      if (!s.moved && rawDx * rawDx + rawDy * rawDy < 9) return
      s.moved = true
      const next = { dx: rawDx / zoom, dy: rawDy / zoom }
      dragRef.current = next
      setDrag(next)
    }
    const onUp = () => {
      dragAbortRef.current?.abort()
      dragAbortRef.current = null
      const s = dragStartRef.current
      dragStartRef.current = null
      const finalDrag = dragRef.current
      dragRef.current = null
      if (s?.moved && finalDrag) {
        canvasApi.getState().moveDrawing(drawing.id, { x: finalDrag.dx, y: finalDrag.dy })
      }
      setDrag(null)
    }
    dragAbortRef.current?.abort()
    const controller = new AbortController()
    dragAbortRef.current = controller
    const { signal } = controller
    window.addEventListener('mousemove', onMove, { signal })
    window.addEventListener('mouseup', onUp, { signal })
    // If the controller is aborted from elsewhere (e.g. a native context menu
    // opened mid-drag), drop any in-progress drag state without committing.
    signal.addEventListener('abort', () => {
      dragStartRef.current = null
      dragRef.current = null
      setDrag(null)
    })
  }

  const onContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Cancel any in-progress drag — the menu will eat the mouseup, so we
    // can't rely on the normal release to clear listeners.
    dragAbortRef.current?.abort()
    dragAbortRef.current = null
    canvasApi.getState().selectDrawing(drawing.id)
    if (!window.electronAPI) return
    const colorSubmenu: NativeContextMenuItem[] = STROKE_COLORS.map((c, i) => ({
      id: `color:${i}`,
      label: drawing.color === c.value ? `${c.label} ✓` : c.label,
    }))
    const id = await window.electronAPI.showContextMenu([
      { label: 'Stroke Color', submenu: colorSubmenu },
      { type: 'separator' as const },
      { id: 'delete', label: 'Delete Stroke' },
    ])
    if (!id) return
    if (id.startsWith('color:')) {
      const idx = parseInt(id.slice(6), 10)
      canvasApi.getState().setDrawingColor(drawing.id, STROKE_COLORS[idx].value)
      return
    }
    if (id === 'delete') canvasApi.getState().removeDrawing(drawing.id)
  }

  // Note: when dragging, the live `drag` offset shifts the visible stroke but
  // the SVG viewBox/bounds were computed from the un-translated points. The
  // outer SVG is large enough (pad-padded) that small drags don't clip; on
  // commit (mouseup) we update the store and the SVG re-anchors on next render.
  const liveTransform = drag ? `translate(${-b.x + pad + drag.dx}, ${-b.y + pad + drag.dy})` : `translate(${-b.x + pad}, ${-b.y + pad})`

  return (
    <svg
      style={{
        position: 'absolute',
        left: b.x - pad,
        top: b.y - pad,
        width: b.w + pad * 2,
        height: b.h + pad * 2,
        pointerEvents: 'none',
        overflow: 'visible',
        zIndex: 100000, // always in front of panels & other canvas content
      }}
    >
      <g transform={liveTransform}>
        {/* Wide invisible hit target so thin strokes are easy to grab. */}
        <path
          d={pointsToPath(drawing.points)}
          stroke="transparent"
          strokeWidth={Math.max(14, drawing.strokeWidth + 10)}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          onMouseDown={onPointerDown}
          onContextMenu={onContextMenu}
          style={{ pointerEvents: 'stroke', cursor: 'move' }}
        />
        {selected && (
          <path
            d={pointsToPath(drawing.points)}
            stroke="rgba(74,158,255,0.55)"
            strokeWidth={drawing.strokeWidth + 6}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            style={{ pointerEvents: 'none' }}
          />
        )}
        <path
          d={pointsToPath(drawing.points)}
          stroke={drawing.color}
          strokeWidth={drawing.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          style={{ pointerEvents: 'none' }}
        />
      </g>
    </svg>
  )
})

const CanvasDrawings: React.FC = () => {
  const drawings = useCanvasStoreContext((s) => Object.values(s.drawings), shallow)
  const selectedId = useCanvasStoreContext((s) => s.selectedDrawingId)
  const canvasApi = useCanvasStoreApi()

  // Delete/Backspace removes the selected drawing. Escape clears selection.
  // Skip if the user is typing into an input — let the field handle the key.
  useEffect(() => {
    if (!selectedId) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const inEditable = !!t && (
        t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.isContentEditable
      )
      if (inEditable) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        canvasApi.getState().removeDrawing(selectedId)
      } else if (e.key === 'Escape') {
        canvasApi.getState().selectDrawing(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, canvasApi])

  // Click on empty canvas (or anything that isn't a stroke path) clears the
  // current drawing selection.
  useEffect(() => {
    if (!selectedId) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t || t.tagName !== 'path') canvasApi.getState().selectDrawing(null)
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [selectedId, canvasApi])

  return (
    <>
      {drawings.map((d) => <Stroke key={d.id} drawing={d} selected={d.id === selectedId} />)}
    </>
  )
}

export default React.memo(CanvasDrawings)
