import { useRef, useState, type PointerEvent } from 'react'
import type { RecentScreenshot } from '../../shared/recentScreenshot'
import { createPortal } from 'react-dom'
import { ArrowCounterClockwise, DownloadSimple } from '@phosphor-icons/react'

type Point = { x: number; y: number }
type Stroke = { color: string; width: number; points: Point[] }

export function ScreenshotDrawing({ id, url, width, height, toolbarHost, onClose, onSaved }: {
  id: string; url: string; width: number; height: number; toolbarHost: HTMLElement | null; onClose: () => void; onSaved: (screenshot: RecentScreenshot, url: string) => void
}) {
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [color, setColor] = useState('#ff453a')
  const [brush, setBrush] = useState(4)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const activePointer = useRef<number | null>(null)
  const point = (event: PointerEvent<SVGSVGElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect()
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
    <svg viewBox={`0 0 ${width} ${height}`} aria-label="Draw on screenshot"
      className="absolute inset-0 h-full w-full touch-none cursor-crosshair rounded-xl"
      onClick={event => event.stopPropagation()}
      onPointerDown={event => {
        if (event.button !== 0 || saving || activePointer.current !== null) return
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
      {strokes.map((stroke, index) => <polyline key={index} points={stroke.points.map(p => `${p.x},${p.y}`).join(' ')}
        fill="none" stroke={stroke.color} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" />)}
    </svg>
    {toolbarHost && createPortal(
    <div role="toolbar" aria-label="Screenshot drawing tools" className="titlebar-no-drag flex max-w-[calc(100vw-160px)] flex-wrap items-center justify-center gap-2 rounded-2xl border border-white/10 bg-neutral-800/90 px-3 py-2 shadow-xl backdrop-blur-md"
      onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
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
        disabled={!strokes.length || saving} onClick={() => { void save() }}><DownloadSimple size={15} />{saving ? 'Saving...' : 'Save'}</button>
      {message && <span role="status" className="absolute left-1/2 top-full mt-2 w-max max-w-[80vw] -translate-x-1/2 rounded-lg bg-neutral-800 px-3 py-2 text-sm text-white">{message}</span>}
    </div>, toolbarHost)}
  </>
}
