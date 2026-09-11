import { useRef, useState } from 'react'
import type { RecentScreenshot } from '../../shared/recentScreenshot'
import { createPortal } from 'react-dom'
import { ArrowCounterClockwise, ChatCircleText, DotsSix, DownloadSimple, PencilSimple, Trash } from '@phosphor-icons/react'

type Point = { x: number; y: number }
type Stroke = { color: string; width: number; points: Point[] }
type Callout = Point & { id: string; text: string; width: number; height: number; rotation: number; manuallySized: boolean }
type Tool = 'pen' | 'comment'
type ResizeEdges = { left: boolean; right: boolean; top: boolean; bottom: boolean }

const ROTATE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M18 8a7 7 0 1 0 1 7M18 4v5h-5' fill='none' stroke='white' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M18 8a7 7 0 1 0 1 7M18 4v5h-5' fill='none' stroke='%23171717' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") 12 12, crosshair`

function unrotatePoint(value: Point, center: Point, rotation: number): Point {
  const angle = -rotation * Math.PI / 180
  const dx = value.x - center.x
  const dy = value.y - center.y
  return { x: center.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: center.y + dx * Math.sin(angle) + dy * Math.cos(angle) }
}

function calloutFontSize(imageHeight: number): number {
  return Math.max(14, Math.min(24, imageHeight / 36))
}

function sizeCallout(text: string, imageWidth: number, imageHeight: number): Pick<Callout, 'width' | 'height'> {
  const fontSize = calloutFontSize(imageHeight)
  const lineHeight = fontSize * 1.25
  const maxTextWidth = Math.max(80, Math.min(imageWidth * 0.6, 420 * imageHeight / 600))
  const lines = text.split('\n')
  const widths = lines.map(line => Math.max(fontSize * 2, line.length * fontSize * 0.58))
  const wrappedLines = widths.reduce((total, lineWidth) => total + Math.max(1, Math.ceil(lineWidth / maxTextWidth)), 0)
  return {
    width: Math.min(imageWidth, Math.max(112, Math.min(maxTextWidth, Math.max(...widths)) + 70)),
    height: Math.min(imageHeight, Math.max(44, wrappedLines * lineHeight + 20)),
  }
}

function bubblePath(context: CanvasRenderingContext2D, callout: Callout, radius: number): void {
  const { x, y, width, height } = callout
  context.beginPath()
  context.moveTo(x + radius, y)
  context.lineTo(x + width - radius, y)
  context.quadraticCurveTo(x + width, y, x + width, y + radius)
  context.lineTo(x + width, y + height - radius)
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  context.lineTo(x + radius, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - radius)
  context.lineTo(x, y + radius)
  context.quadraticCurveTo(x, y, x + radius, y)
  context.closePath()
}

function drawCallout(context: CanvasRenderingContext2D, callout: Callout, imageHeight: number): void {
  const centerX = callout.x + callout.width / 2
  const centerY = callout.y + callout.height / 2
  context.save()
  context.translate(centerX, centerY)
  context.rotate(callout.rotation * Math.PI / 180)
  context.translate(-centerX, -centerY)
  bubblePath(context, callout, Math.min(18, callout.height / 5))
  context.fillStyle = 'rgba(18,18,18,0.32)'
  context.fill()
  context.strokeStyle = 'rgba(255,255,255,0.32)'
  context.lineWidth = Math.max(1, imageHeight / 900)
  context.stroke()
  const fontSize = calloutFontSize(imageHeight)
  const lineHeight = fontSize * 1.25
  context.fillStyle = '#ffffff'
  context.font = `600 ${fontSize}px system-ui, sans-serif`
  context.textBaseline = 'top'
  const maxWidth = callout.width - 28
  const lines: string[] = []
  for (const paragraph of callout.text.trim().split('\n')) {
    const paragraphLines: string[] = []
    for (const word of paragraph.split(/\s+/)) {
      const candidate = paragraphLines.length ? `${paragraphLines[paragraphLines.length - 1]} ${word}` : word
      if (paragraphLines.length && context.measureText(candidate).width > maxWidth) paragraphLines.push(word)
      else if (paragraphLines.length) paragraphLines[paragraphLines.length - 1] = candidate
      else paragraphLines.push(candidate)
    }
    lines.push(...(paragraphLines.length ? paragraphLines : ['']))
  }
  lines.slice(0, Math.max(1, Math.floor((callout.height - 24) / lineHeight))).forEach((line, index) => {
    context.fillText(line, callout.x + 14, callout.y + 12 + index * lineHeight, maxWidth)
  })
  context.restore()
}

export function ScreenshotDrawing({ id, url, width, height, toolbarHost, onClose, onSaved }: {
  id: string; url: string; width: number; height: number; toolbarHost: HTMLElement | null; onClose: () => void; onSaved: (screenshot: RecentScreenshot, url: string) => void
}) {
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [callouts, setCallouts] = useState<Callout[]>([])
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState('#ff453a')
  const [brush, setBrush] = useState(4)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const activePointer = useRef<number | null>(null)
  const calloutDrag = useRef<{ id: string; pointerId: number; point: Point; x: number; y: number } | null>(null)
  const calloutResize = useRef<{ id: string; pointerId: number; point: Point; x: number; y: number; width: number; height: number; rotation: number; edges: ResizeEdges } | null>(null)
  const calloutRotation = useRef<{ id: string; pointerId: number; center: Point; angle: number; rotation: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const point = (event: { clientX: number; clientY: number }): Point => {
    const bounds = svgRef.current?.getBoundingClientRect()
    if (!bounds) return { x: 0, y: 0 }
    return {
      x: Math.max(0, Math.min(width, (event.clientX - bounds.left) * width / bounds.width)),
      y: Math.max(0, Math.min(height, (event.clientY - bounds.top) * height / bounds.height)),
    }
  }
  const save = async () => {
    setSaving(true)
    setMessage('')
    try {
      const original = new Image()
      original.src = url
      await original.decode()
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Drawing is unavailable.')
      context.drawImage(original, 0, 0, width, height)
      context.lineCap = 'round'
      context.lineJoin = 'round'
      for (const stroke of strokes) {
        context.strokeStyle = stroke.color
        context.lineWidth = stroke.width
        context.beginPath()
        context.moveTo(stroke.points[0].x, stroke.points[0].y)
        for (const p of stroke.points.slice(1)) context.lineTo(p.x, p.y)
        context.stroke()
      }
      for (const callout of callouts) {
        if (callout.text.trim()) drawCallout(context, callout, height)
      }
      const dataUrl = canvas.toDataURL('image/png')
      if (typeof window.electronAPI.saveRecentScreenshot !== 'function') {
        setMessage('Restart Cate to enable saving to the screenshot stack. Your drawing is still here.')
        return
      }
      const saved = await window.electronAPI.saveRecentScreenshot(id, dataUrl)
      onSaved(saved, dataUrl)
    } catch (error) {
      console.error('Could not save annotated screenshot', error)
      setMessage('Could not save. Your drawing is still here; try again.')
    } finally {
      setSaving(false)
    }
  }
  const buttonClass = 'flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white'
  return <>
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} aria-label="Annotate screenshot"
      className="absolute inset-0 h-full w-full touch-none cursor-crosshair rounded-xl"
      onClick={event => {
        event.stopPropagation()
        if (tool !== 'comment' || saving) return
        const p = point(event)
        const { width: bubbleWidth, height: bubbleHeight } = sizeCallout('', width, height)
        setCallouts(current => [...current, {
          id: crypto.randomUUID(), text: '', width: bubbleWidth, height: bubbleHeight, rotation: 0, manuallySized: false,
          x: Math.max(0, Math.min(width - bubbleWidth, p.x - bubbleWidth / 2)),
          y: Math.max(0, Math.min(height - bubbleHeight, p.y - bubbleHeight / 2)),
        }])
      }}
      onPointerDown={event => {
        if (tool !== 'pen' || event.button !== 0 || saving || activePointer.current !== null) return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        activePointer.current = event.pointerId
        const p = point(event)
        setMessage('')
        setStrokes(current => [...current, { color, width: brush * height / 600, points: [p, { x: p.x + 0.01, y: p.y }] }])
      }}
      onPointerMove={event => {
        if (activePointer.current !== event.pointerId) return
        const p = point(event)
        setStrokes(current => current.map((stroke, index) => index === current.length - 1 ? { ...stroke, points: [...stroke.points, p] } : stroke))
      }}
      onPointerUp={event => { if (activePointer.current === event.pointerId) activePointer.current = null }}
      onPointerCancel={() => { activePointer.current = null }}
      onLostPointerCapture={() => { activePointer.current = null }}>
      <rect width={width} height={height} fill="transparent" pointerEvents="all" />
      {strokes.map((stroke, index) => <polyline key={index} points={stroke.points.map(p => `${p.x},${p.y}`).join(' ')}
        fill="none" stroke={stroke.color} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" />)}
      {callouts.map((callout, index) => {
        const center = { x: callout.x + callout.width / 2, y: callout.y + callout.height / 2 }
        return <g key={callout.id} transform={`rotate(${callout.rotation} ${center.x} ${center.y})`}>
          <foreignObject x={callout.x} y={callout.y} width={callout.width} height={callout.height}
            onClick={event => event.stopPropagation()}>
          <div className="group relative h-full w-full overflow-hidden rounded-2xl bg-black/30 text-white shadow-xl backdrop-blur-sm">
            <button type="button" aria-label={`Move comment ${index + 1}`} title="Drag comment"
              className="absolute left-1.5 top-1/2 z-10 -translate-y-1/2 cursor-grab rounded-full p-1 text-white/65 hover:bg-white/15 hover:text-white active:cursor-grabbing"
              onClick={event => event.stopPropagation()}
              onPointerDown={event => {
                event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId)
                calloutDrag.current = { id: callout.id, pointerId: event.pointerId, point: point(event), x: callout.x, y: callout.y }
              }}
              onPointerMove={event => {
                const drag = calloutDrag.current
                if (!drag || drag.id !== callout.id || drag.pointerId !== event.pointerId) return
                const current = point(event)
                setCallouts(values => values.map(value => value.id === callout.id ? {
                  ...value,
                  x: Math.max(0, Math.min(width - value.width, drag.x + current.x - drag.point.x)),
                  y: Math.max(0, Math.min(height - value.height, drag.y + current.y - drag.point.y)),
                } : value))
              }}
              onPointerUp={event => { if (calloutDrag.current?.pointerId === event.pointerId) calloutDrag.current = null }}
              onPointerCancel={() => { calloutDrag.current = null }}><DotsSix size={15} weight="bold" /></button>
            <button type="button" aria-label={`Delete comment ${index + 1}`} className="absolute right-1.5 top-1/2 z-10 -translate-y-1/2 rounded-full p-1 text-white/65 opacity-0 transition-opacity hover:bg-white/15 hover:text-white group-hover:opacity-100 group-focus-within:opacity-100"
              onPointerDown={event => event.stopPropagation()} onClick={() => setCallouts(current => current.filter(value => value.id !== callout.id))}><Trash size={12} /></button>
            <textarea autoFocus={index === callouts.length - 1} aria-label={`Comment ${index + 1}`} placeholder="Add a comment…" value={callout.text}
              onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
              onChange={event => {
                const text = event.target.value
                setCallouts(current => current.map(value => value.id === callout.id ? {
                  ...value, ...(value.manuallySized ? {} : sizeCallout(text, width, height)), text,
                } : value))
              }}
              className="h-full w-full resize-none overflow-auto bg-transparent py-2.5 pl-9 pr-8 font-semibold leading-tight text-white outline-none placeholder:text-white/55"
              style={{ fontSize: calloutFontSize(height) }} />
          </div>
          </foreignObject>
          <g aria-label={`Resize comment ${index + 1}`} className="cursor-nwse-resize"
            onClick={event => event.stopPropagation()}
            onPointerDown={event => {
              event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId)
              const current = point(event)
              const local = unrotatePoint(current, center, callout.rotation)
              const horizontal = Math.abs(local.x - callout.x) < Math.abs(local.x - callout.x - callout.width) ? 'left' : 'right'
              const vertical = Math.abs(local.y - callout.y) < Math.abs(local.y - callout.y - callout.height) ? 'top' : 'bottom'
              const nearHorizontal = Math.min(Math.abs(local.x - callout.x), Math.abs(local.x - callout.x - callout.width)) <= 14
              const nearVertical = Math.min(Math.abs(local.y - callout.y), Math.abs(local.y - callout.y - callout.height)) <= 14
              calloutResize.current = {
                id: callout.id, pointerId: event.pointerId, point: current, x: callout.x, y: callout.y, width: callout.width, height: callout.height, rotation: callout.rotation,
                edges: { left: nearHorizontal && horizontal === 'left', right: nearHorizontal && horizontal === 'right', top: nearVertical && vertical === 'top', bottom: nearVertical && vertical === 'bottom' },
              }
            }}
            onPointerMove={event => {
              const drag = calloutResize.current
              if (!drag || drag.id !== callout.id || drag.pointerId !== event.pointerId) return
              const localStart = unrotatePoint(drag.point, center, drag.rotation)
              const localCurrent = unrotatePoint(point(event), center, drag.rotation)
              const dx = localCurrent.x - localStart.x
              const dy = localCurrent.y - localStart.y
              let x = drag.x; let y = drag.y; let nextWidth = drag.width; let nextHeight = drag.height
              if (drag.edges.right) nextWidth = Math.max(80, Math.min(width - x, drag.width + dx))
              if (drag.edges.bottom) nextHeight = Math.max(44, Math.min(height - y, drag.height + dy))
              if (drag.edges.left) { x = Math.max(0, Math.min(drag.x + drag.width - 80, drag.x + dx)); nextWidth = drag.width + drag.x - x }
              if (drag.edges.top) { y = Math.max(0, Math.min(drag.y + drag.height - 44, drag.y + dy)); nextHeight = drag.height + drag.y - y }
              setCallouts(values => values.map(value => value.id === callout.id ? { ...value, x, y, width: nextWidth, height: nextHeight, manuallySized: true } : value))
            }}
            onPointerUp={event => { if (calloutResize.current?.pointerId === event.pointerId) calloutResize.current = null }}
            onPointerCancel={() => { calloutResize.current = null }}>
            <rect x={callout.x} y={callout.y} width={callout.width} height={callout.height}
              fill="none" stroke="transparent" strokeWidth="16" pointerEvents="stroke" />
          </g>
          <g aria-label={`Rotate comment ${index + 1}`} style={{ cursor: ROTATE_CURSOR }}
            onClick={event => event.stopPropagation()}
            onPointerDown={event => {
              event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId)
              const current = point(event)
              calloutRotation.current = { id: callout.id, pointerId: event.pointerId, center, angle: Math.atan2(current.y - center.y, current.x - center.x), rotation: callout.rotation }
            }}
            onPointerMove={event => {
              const drag = calloutRotation.current
              if (!drag || drag.id !== callout.id || drag.pointerId !== event.pointerId) return
              const current = point(event)
              const angle = Math.atan2(current.y - drag.center.y, current.x - drag.center.x)
              setCallouts(values => values.map(value => value.id === callout.id ? { ...value, rotation: drag.rotation + (angle - drag.angle) * 180 / Math.PI } : value))
            }}
            onPointerUp={event => { if (calloutRotation.current?.pointerId === event.pointerId) calloutRotation.current = null }}
            onPointerCancel={() => { calloutRotation.current = null }}>
            <rect x={callout.x - 20} y={callout.y - 20} width={callout.width + 40} height={callout.height + 40}
              rx={20} fill="none" stroke="transparent" strokeWidth="12" pointerEvents="stroke" />
          </g>
        </g>
      })}
    </svg>
    {toolbarHost && createPortal(
    <div role="toolbar" aria-label="Screenshot drawing tools" className="titlebar-no-drag flex max-w-[calc(100vw-160px)] flex-wrap items-center justify-center gap-2 rounded-2xl border border-white/10 bg-neutral-800/90 px-3 py-2 shadow-xl backdrop-blur-md"
      onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
      <button type="button" aria-label="Draw with pen" title="Pen" aria-pressed={tool === 'pen'} onClick={() => setTool('pen')}
        className={`flex h-9 w-9 items-center justify-center rounded-full ${tool === 'pen' ? 'bg-white text-neutral-900' : 'bg-white/10 text-white/70 hover:bg-white/20 hover:text-white'}`}><PencilSimple size={17} /></button>
      <button type="button" aria-label="Add comment" title="Comment" aria-pressed={tool === 'comment'} onClick={() => setTool('comment')}
        className={`flex h-9 w-9 items-center justify-center rounded-full ${tool === 'comment' ? 'bg-white text-neutral-900' : 'bg-white/10 text-white/70 hover:bg-white/20 hover:text-white'}`}><ChatCircleText size={17} /></button>
      <div className="flex items-center gap-2" aria-label="Pen colors">
        {['#ff453a', '#ffcc00', '#30d158', '#0a84ff', '#ffffff'].map(value => <button key={value} type="button"
          aria-label={`Pen color ${value}`} aria-pressed={color === value} onClick={() => setColor(value)}
          className={`h-5 w-5 rounded-full border border-white/20 transition-shadow ${color === value ? 'ring-2 ring-white ring-offset-2 ring-offset-neutral-800' : 'hover:ring-2 hover:ring-white/40'}`}
          style={{ backgroundColor: value }} />)}
      </div>
      <span className="mx-1 h-5 w-px bg-white/10" />
      <div className="flex items-center gap-0.5" aria-label="Pen thickness">
        {[2, 4, 8].map(value => <button key={value} type="button" aria-label={`Pen thickness ${value}`} aria-pressed={brush === value}
          className={`flex h-8 w-8 items-center justify-center rounded-full ${brush === value ? 'bg-white/15' : 'hover:bg-white/10'}`}
          onClick={() => setBrush(value)}><span className="rounded-full bg-white" style={{ width: value + 2, height: value + 2 }} /></button>)}
      </div>
      <button type="button" aria-label="Undo drawing" title="Undo last stroke" className={buttonClass} disabled={!strokes.length || saving}
        onClick={() => setStrokes(current => current.slice(0, -1))}><ArrowCounterClockwise size={17} /></button>
      <span className="h-5 w-px bg-white/10" />
      <button type="button" className={buttonClass} disabled={saving} onClick={onClose}>Cancel</button>
      <button type="button" className="flex h-8 items-center gap-1.5 rounded-full bg-white px-3 text-xs font-semibold text-neutral-900 transition-colors hover:bg-white/90 disabled:opacity-35"
        disabled={(!strokes.length && !callouts.some(callout => callout.text.trim())) || saving} onClick={() => { void save() }}><DownloadSimple size={15} />{saving ? 'Saving...' : 'Save'}</button>
      {message && <span role="status" className="absolute left-1/2 top-full mt-2 w-max max-w-[80vw] -translate-x-1/2 rounded-lg bg-neutral-800 px-3 py-2 text-sm text-white">{message}</span>}
    </div>, toolbarHost)}
  </>
}
