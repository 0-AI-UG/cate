import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CaretLeft, CaretRight, DownloadSimple, Minus, PencilSimple, Plus, X } from '@phosphor-icons/react'
import type { RecentScreenshot } from '../../shared/recentScreenshot'
import { Tooltip } from '../ui/Tooltip'
import { createPortal } from 'react-dom'
import { ScreenshotDrawing } from './ScreenshotDrawing'

function ScreenshotViewer({ screenshots, initialIndex, onClose, onSaved }: {
  screenshots: RecentScreenshot[]
  initialIndex: number
  onClose: () => void
  onSaved: (screenshot: RecentScreenshot) => void
}) {
  const [index, setIndex] = useState(initialIndex)
  const [image, setImage] = useState<{ id: string; url: string; width: number; height: number } | null>(null)
  const [errorId, setErrorId] = useState<string | null>(null)
  const [zoom, setZoom] = useState<number | null>(null)
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight })
  const [drawingToolbarHost, setDrawingToolbarHost] = useState<HTMLDivElement | null>(null)
  const [editing, setEditing] = useState(false)
  const [direction, setDirection] = useState(1)
  const scrollRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (scrollRef.current) { scrollRef.current.scrollTop = 0; scrollRef.current.scrollLeft = 0 }
  }, [image?.id])
  const imageElementRef = useRef<HTMLDivElement>(null)
  const directionRef = useRef(direction)
  directionRef.current = direction
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', resize)
    const previous = document.activeElement
    dialogRef.current?.focus({ preventScroll: true })
    return () => {
      window.removeEventListener('resize', resize)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  const screenshot = screenshots[index]
  useEffect(() => {
    let active = true
    setErrorId(null)
    void window.electronAPI.fsReadBinary(screenshot.filePath).then(async bytes => {
      if (!active) return
      // Cate allows data: images, but its content security policy blocks blob: URLs.
      const data = new Uint8Array(bytes)
      let binary = ''
      for (let offset = 0; offset < data.length; offset += 8192) {
        binary += String.fromCharCode(...data.subarray(offset, offset + 8192))
      }
      const extension = screenshot.filePath.split('.').pop()?.toLowerCase()
      const format = extension === 'jpg' ? 'jpeg' : extension === 'tif' ? 'tiff' : extension
      const url = `data:image/${format || 'png'};base64,${btoa(binary)}`
      const decoded = new Image()
      decoded.src = url
      await decoded.decode()
      if (!active) return
      const previous = imageElementRef.current
      if (previous?.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const animation = previous.animate([
          { opacity: 1, transform: 'translateX(0)' },
          { opacity: 0, transform: `translateX(${-directionRef.current * 28}px)` },
        ], { duration: 120, easing: 'ease-in', fill: 'forwards' })
        await animation.finished.catch(() => {})
        if (!active) { animation.cancel(); return }
      }
      setZoom(null)
      setImage({ id: screenshot.id, url, width: decoded.naturalWidth, height: decoded.naturalHeight })
    }).catch(() => {
      if (active) setErrorId(screenshot.id)
    })
    return () => {
      active = false
    }
  }, [screenshot.id, screenshot.filePath])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'Escape', 'Tab'].includes(event.key)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.key === 'Escape') { if (editing) setEditing(false); else onClose(); return }
      if (event.key === 'Tab') {
        const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') ?? [])
        const current = buttons.indexOf(document.activeElement as HTMLElement)
        buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
        return
      }
      if (editing) return
      setDirection(event.key === 'ArrowLeft' ? -1 : 1)
      setIndex(current => (current + (event.key === 'ArrowLeft' ? -1 : 1) + screenshots.length) % screenshots.length)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [screenshots.length, onClose, editing])

  const displayHeight = Math.max(80, viewport.height - 160)
  const fit = image ? Math.min(1, Math.max(1, viewport.width - 96) / image.width, displayHeight / image.height) : 1
  const scale = zoom ?? fit
  const controlClass = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/90 transition-colors hover:bg-white/20 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-30'

  return createPortal(
    <div className="titlebar-no-drag fixed inset-0 z-[100000] bg-black/90" onClick={onClose}
      onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()} onMouseMove={event => event.stopPropagation()}
      onWheel={event => event.stopPropagation()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Screenshot preview" tabIndex={-1}
        className="flex h-full flex-col outline-none">
        <div ref={setDrawingToolbarHost} className="absolute left-1/2 top-3 z-20 -translate-x-1/2" />
        <div className="absolute right-3 top-3 z-10 flex gap-2" onClick={event => event.stopPropagation()}>
          <button type="button" aria-label="Edit screenshot" title="Draw on screenshot" className={`${controlClass} backdrop-blur-md`}
            disabled={!image || image.id !== screenshot.id} aria-pressed={editing}
            onClick={() => setEditing(value => !value)}><PencilSimple size={18} /></button>
          {image?.id === screenshot.id && <a href={image.url} download={screenshot.filePath.split('/').pop()}
            aria-label="Download screenshot" title="Download screenshot" className={`${controlClass} backdrop-blur-md`}><DownloadSimple size={18} /></a>}
          <button type="button" aria-label="Close screenshot preview" title="Close (Esc)"
            className={`${controlClass} backdrop-blur-md`} onClick={onClose}><X size={18} /></button>
        </div>
        <div className="relative mx-auto mt-12 shrink-0 max-w-[calc(100vw-96px)]"
          style={{ width: viewport.width - 96, height: displayHeight }}>
          <div ref={scrollRef} className="h-full overflow-auto">
          <div className="grid min-h-full min-w-full w-max place-items-center">
            {errorId === screenshot.id ? (
              <p role="alert" className="p-4 text-center text-white/70">Could not load the original screenshot.</p>
            ) : image ? (
              <div ref={imageElementRef} key={image.id} className="screenshot-viewer-image-in relative" style={{ animationName: direction > 0 ? 'screenshot-slide-from-right' : 'screenshot-slide-from-left' }}>
              <img src={image.url} alt={`Screenshot ${screenshots.findIndex(shot => shot.id === image.id) + 1} of ${screenshots.length}`}
                onClick={event => event.stopPropagation()} onError={() => setErrorId(screenshot.id)} draggable={false}
                style={{ width: image.width * scale, height: image.height * scale }}
                className="block max-w-none rounded-xl shadow-2xl" />
              {editing && <ScreenshotDrawing id={image.id} url={image.url} width={image.width} height={image.height}
                toolbarHost={drawingToolbarHost} onClose={() => setEditing(false)}
                onSaved={saved => onSaved(saved)} />}
              </div>
            ) : <p role="status" className="p-4 text-center text-white/70">Loading screenshot...</p>}
          </div>
        </div>
        </div>
        <div className="flex h-20 shrink-0 items-center justify-center gap-3">
          <div className="flex items-center gap-1 rounded-full bg-neutral-800/80 p-1 shadow-lg backdrop-blur-md" onClick={event => event.stopPropagation()}>
            <button type="button" aria-label="Previous screenshot" title="Previous screenshot (Left arrow)"
              className={controlClass} disabled={screenshots.length < 2 || editing}
              onClick={() => { setDirection(-1); setIndex(current => (current - 1 + screenshots.length) % screenshots.length) }}><CaretLeft size={18} /></button>
            <span className="min-w-10 text-center text-xs text-white/80" aria-live="polite">{index + 1} / {screenshots.length}</span>
            <button type="button" aria-label="Next screenshot" title="Next screenshot (Right arrow)"
              className={controlClass} disabled={screenshots.length < 2 || editing}
              onClick={() => { setDirection(1); setIndex(current => (current + 1) % screenshots.length) }}><CaretRight size={18} /></button>
          </div>
          <div className="flex items-center gap-1 rounded-full bg-neutral-800/80 p-1 shadow-lg backdrop-blur-md" onClick={event => event.stopPropagation()}>
            <button type="button" aria-label="Zoom out" className={controlClass} disabled={scale <= 0.05}
              onClick={() => setZoom(Math.max(0.05, scale / 1.2))}><Minus size={16} /></button>
            <button type="button" aria-label="Fit screenshot" title="Fit to window" onClick={() => setZoom(null)}
              className="min-w-14 rounded-full py-2 text-center text-xs text-white/90 hover:bg-white/10">{Math.round(scale * 100)}%</button>
            <button type="button" aria-label="Zoom in" className={controlClass} disabled={scale >= 4}
              onClick={() => setZoom(Math.min(4, scale * 1.2))}><Plus size={16} /></button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function RecentScreenshotButton({ expandDown = false }: { expandDown?: boolean }) {
  const [screenshots, setScreenshots] = useState<RecentScreenshot[]>([])
  const [dismissed, setDismissed] = useState<string[]>([])
  const [expanded, setExpanded] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [viewer, setViewer] = useState<{ screenshots: RecentScreenshot[]; initialIndex: number } | null>(null)
  const dragged = useRef(false)

  useEffect(() => {
    // Renderer hot reload can run against an older preload bridge until restart.
    const api = window.electronAPI
    if (typeof api?.onRecentScreenshotChanged !== 'function'
      || typeof api.getRecentScreenshot !== 'function'
      || typeof api.dragRecentScreenshot !== 'function') return

    const receive = (value: RecentScreenshot[] | RecentScreenshot | null) => {
      const recent = Array.isArray(value) ? value : value ? [value] : []
      setScreenshots(recent)
      setDismissed(ids => ids.filter(id => recent.some(screenshot => screenshot.id === id)))
    }
    let mounted = true
    let receivedChange = false
    const unsubscribe = window.electronAPI.onRecentScreenshotChanged(value => {
      receivedChange = true
      receive(value)
    })
    void window.electronAPI.getRecentScreenshot().then(value => {
      if (mounted && !receivedChange) receive(value)
    }).catch(() => { /* Screenshot monitoring is optional. */ })
    return () => { mounted = false; unsubscribe() }
  }, [])

  const visible = screenshots.filter(screenshot => !dismissed.includes(screenshot.id))
  if (!visible.length && !viewer) return null
  return (
    <>
    <div
      className="relative w-10 transition-[height] duration-200 ease-out motion-reduce:transition-none"
      style={{ height: expanded ? 40 + (visible.length - 1) * 52 : 40 }}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false) }}
    >
      {visible.map((screenshot, index) => (
        <div key={screenshot.id} className="group absolute h-10 w-10 transition-[transform,top,bottom] duration-200 ease-out motion-reduce:transition-none"
          onMouseEnter={() => setHoveredId(screenshot.id)}
          onMouseLeave={() => setHoveredId(null)}
          style={{
            [expandDown ? 'top' : 'bottom']: expanded ? index * 52 : index * 5,
            zIndex: visible.length - index,
            transform: `rotate(${hoveredId === screenshot.id ? 8 : 3}deg) scale(${hoveredId === screenshot.id ? 1.05 : expanded ? 1 : 1 - index * 0.04})`,
          }}
        >
          <Tooltip label="Click to view or drag screenshot to a panel" placement="left">
            <button
              type="button"
              aria-label="Open screenshot preview"
              className="block h-10 w-10 cursor-grab overflow-hidden rounded-lg border-0 bg-transparent p-0 ring-1 ring-[var(--border-strong)] transition-[transform,filter] duration-200 ease-out group-hover:brightness-110 active:scale-95 active:cursor-grabbing motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              draggable
              onPointerDown={() => { dragged.current = false }}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') dragged.current = false
              }}
              onClick={() => {
                if (dragged.current) return
                setViewer({ screenshots: visible, initialIndex: index })
              }}
              onDragStart={event => {
                dragged.current = true
                event.preventDefault()
                void window.electronAPI.dragRecentScreenshot(screenshot.id).catch(() => {
                  // Keep the shortcut available if the native drag could not start.
                })
              }}
            >
              <img src={screenshot.dataUrl} alt="Recent screenshot" draggable={false}
                className="h-full w-full object-contain" />
            </button>
          </Tooltip>
          {screenshot.annotated && <span aria-label="Annotated screenshot" className="pointer-events-none absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-black/75 text-white shadow-sm group-hover:opacity-0 group-focus-within:opacity-0">
            <PencilSimple size={9} weight="bold" />
          </span>}
          <button
            type="button"
            aria-label="Dismiss screenshot preview"
            onClick={() => setDismissed(ids => [...ids, screenshot.id])}
            className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-surface-2 text-secondary opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-primary focus-visible:outline focus-visible:outline-2 motion-reduce:transition-none"
          >
            <X size={10} weight="bold" />
          </button>
        </div>
      ))}
    </div>
    {viewer && <ScreenshotViewer {...viewer} onClose={() => setViewer(null)} onSaved={saved => {
      setScreenshots(current => [saved, ...current.filter(shot => shot.id !== saved.id)].slice(0, 5))
      setViewer(null)
    }} />}
    </>
  )
}
