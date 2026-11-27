// The canvas's draw tool, an item of the canvas toolbar: the pencil button
// picks it, and while it is picked a second bar above the toolbar sets the
// pen (pen, highlighter, arrow, eraser, line, rectangle, ellipse), colour,
// width, dashes and fill, and a surface over the canvas turns presses into
// strokes. The strokes of one session (until the tool is put away) go into
// one drawing panel (`./strokes`). Wheel and trackpad still pan and zoom.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, Circle, Eraser, Highlighter, Minus, Pencil, Plus, Slash, Square, SquareDashed } from 'lucide-react'
import { STROKE_KINDS, type Stroke, type StrokeKind } from '@panels/drawing/contract'
import {
  CanvasToolbarButton, canvasContainerFor, useCanvasUi, useCanvasView, useCanvasViewStore, type CanvasToolbarItemProps,
} from '../../client/layout/canvas'
import { useT } from '../../kernel/settings'
import { DRAW_COLORS, HIGHLIGHTER_SCALE, useDrawState, type DrawTool } from './drawState'
import { StrokeShape } from './StrokeShape'
import { commitStroke, eraseAt } from './strokes'

const PENS: { tool: DrawTool; label: string; icon: ReactNode }[] = [
  { tool: 'pen', label: 'Pen', icon: <Pencil size={16} /> },
  { tool: 'highlighter', label: 'Highlighter', icon: <Highlighter size={16} /> },
  { tool: 'arrow', label: 'Arrow', icon: <ArrowUpRight size={16} /> },
  { tool: 'eraser', label: 'Eraser', icon: <Eraser size={16} /> },
  { tool: 'line', label: 'Line', icon: <Slash size={16} /> },
  { tool: 'rect', label: 'Rectangle', icon: <Square size={16} /> },
  { tool: 'ellipse', label: 'Ellipse', icon: <Circle size={16} /> },
]

/** The eraser's reach, in screen pixels. */
const ERASER_RADIUS = 8

function BarButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={`flex h-8 min-w-8 items-center justify-center rounded-full px-1.5 transition-colors ${
        active ? 'bg-focus-blue/20 text-focus-blue' : 'text-secondary hover:bg-hover-strong hover:text-primary'
      }`}
    >
      {children}
    </button>
  )
}

const Divider = () => <div aria-hidden className="mx-1 h-5 w-px bg-surface-5" />

/** The pen settings bar, above the toolbar card the pencil sits in. */
function DrawBar({ anchor }: { anchor: HTMLElement }) {
  const t = useT()
  const { tool, color, width, dashed, filled, setTool, setColor, setWidth, toggleDashed, toggleFilled } = useDrawState()
  const [colorsOpen, setColorsOpen] = useState(false)
  const [rect, setRect] = useState(() => anchor.getBoundingClientRect())

  useLayoutEffect(() => {
    const measure = () => setRect(anchor.getBoundingClientRect())
    const observer = new ResizeObserver(measure)
    observer.observe(anchor)
    window.addEventListener('resize', measure)
    measure()
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [anchor])

  return createPortal(
    <div
      role="toolbar"
      aria-label={t('Draw')}
      data-draw-bar
      className="fixed z-[90] flex items-center gap-0.5 rounded-full border border-subtle bg-surface-0 px-1.5 py-1 shadow-[0_8px_24px_-6px_var(--shadow-node)]"
      style={{ left: rect.left + rect.width / 2, bottom: window.innerHeight - rect.top + 10, transform: 'translateX(-50%)' }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {PENS.map((pen) => (
        <BarButton key={pen.tool} label={t(pen.label)} active={tool === pen.tool} onClick={() => setTool(pen.tool)}>{pen.icon}</BarButton>
      ))}
      <Divider />
      <div className="relative">
        <BarButton label={t('Stroke color')} active={colorsOpen} onClick={() => setColorsOpen((open) => !open)}>
          <span className="h-4 w-4 rounded-full border border-subtle" style={{ backgroundColor: color }} />
        </BarButton>
        {colorsOpen && (
          <div className="absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-subtle bg-surface-0 px-2 py-1.5 shadow-[0_8px_24px_-6px_var(--shadow-node)]">
            {DRAW_COLORS.map((option) => (
              <button
                key={option}
                type="button"
                aria-label={option}
                aria-pressed={option === color}
                onClick={() => { setColor(option); setColorsOpen(false) }}
                className={`h-4 w-4 rounded-full border border-subtle ${option === color ? 'ring-2 ring-focus-blue ring-offset-1 ring-offset-surface-0' : ''}`}
                style={{ backgroundColor: option }}
              />
            ))}
          </div>
        )}
      </div>
      <Divider />
      <BarButton label={t('Thinner')} onClick={() => setWidth(width - 1)}><Minus size={14} /></BarButton>
      <span className="min-w-9 select-none text-center font-mono text-[12px] text-secondary">{width}pt</span>
      <BarButton label={t('Thicker')} onClick={() => setWidth(width + 1)}><Plus size={14} /></BarButton>
      <Divider />
      <BarButton label={t('Dashed line')} active={dashed} onClick={toggleDashed}>
        <span aria-hidden className={`block w-5 border-t-2 border-current ${dashed ? 'border-dashed' : ''}`} />
      </BarButton>
      <BarButton label={t('Fill shapes')} active={filled} onClick={toggleFilled}>
        {filled ? <Square size={16} fill="currentColor" fillOpacity={0.35} /> : <SquareDashed size={16} />}
      </BarButton>
    </div>,
    document.body,
  )
}

/** Keeps a line at 45° steps and a shape square while Shift is down. */
function constrain(kind: StrokeKind, x1: number, y1: number, x2: number, y2: number): [number, number] {
  const dx = x2 - x1, dy = y2 - y1
  if (kind === 'rect' || kind === 'ellipse') {
    const side = Math.max(Math.abs(dx), Math.abs(dy))
    return [x1 + Math.sign(dx || 1) * side, y1 + Math.sign(dy || 1) * side]
  }
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  const length = Math.hypot(dx, dy)
  return [x1 + Math.cos(angle) * length, y1 + Math.sin(angle) * length]
}

/** The surface over the canvas that turns presses into strokes. */
function DrawSurface({ workspaceId, canvasId, canvasPanelId, container }: {
  workspaceId: string
  canvasId: string
  canvasPanelId: string
  container: HTMLElement
}) {
  const store = useCanvasViewStore()
  const zoom = useCanvasView((s) => s.zoomLevel)
  const offset = useCanvasView((s) => s.viewportOffset)
  const tool = useDrawState((s) => s.tool)
  const [draft, setDraft] = useState<Stroke | null>(null)
  const draftRef = useRef<Stroke | null>(null)
  const erasing = useRef(false)

  const canvasPoint = (event: React.PointerEvent) => {
    const box = container.getBoundingClientRect()
    return store.getState().viewToCanvas({ x: event.clientX - box.left, y: event.clientY - box.top })
  }
  const show = (stroke: Stroke | null) => { draftRef.current = stroke; setDraft(stroke) }
  const eraseRadius = () => ERASER_RADIUS / store.getState().zoomLevel

  return createPortal(
    <div
      data-draw-surface
      className="absolute inset-0"
      style={{ zIndex: 40, cursor: tool === 'eraser' ? 'cell' : 'crosshair', touchAction: 'none' }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        const p = canvasPoint(event)
        if (tool === 'eraser') {
          erasing.current = true
          eraseAt(workspaceId, canvasId, p, eraseRadius())
          return
        }
        const { color, width, dashed, filled } = useDrawState.getState()
        const kind = tool as StrokeKind
        if (!(STROKE_KINDS as readonly string[]).includes(kind)) return
        const freehand = kind === 'pen' || kind === 'highlighter'
        show({
          kind,
          points: freehand ? [p.x, p.y] : [p.x, p.y, p.x, p.y],
          color,
          width: kind === 'highlighter' ? width * HIGHLIGHTER_SCALE : width,
          dashed: dashed && kind !== 'highlighter',
          filled: filled && (kind === 'rect' || kind === 'ellipse'),
        })
      }}
      onPointerMove={(event) => {
        const p = canvasPoint(event)
        if (erasing.current) { eraseAt(workspaceId, canvasId, p, eraseRadius()); return }
        const current = draftRef.current
        if (!current) return
        if (current.kind === 'pen' || current.kind === 'highlighter') {
          const n = current.points.length
          // Points closer than a screen pixel or so add nothing.
          if (Math.hypot(p.x - current.points[n - 2], p.y - current.points[n - 1]) * store.getState().zoomLevel < 1.5) return
          show({ ...current, points: [...current.points, p.x, p.y] })
          return
        }
        const [x1, y1] = current.points
        const [x2, y2] = event.shiftKey ? constrain(current.kind, x1, y1, p.x, p.y) : [p.x, p.y]
        show({ ...current, points: [x1, y1, x2, y2] })
      }}
      onPointerUp={(event) => {
        erasing.current = false
        const stroke = draftRef.current
        show(null)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        if (!stroke) return
        // A shape with no size (a click) is dropped; a pen click is a dot.
        if (stroke.points.length === 4 && !(stroke.kind === 'pen' || stroke.kind === 'highlighter')) {
          const [x1, y1, x2, y2] = stroke.points
          if (Math.hypot(x2 - x1, y2 - y1) * store.getState().zoomLevel < 3) return
        }
        commitStroke(workspaceId, canvasId, canvasPanelId, stroke)
      }}
      onPointerCancel={() => { erasing.current = false; show(null) }}
    >
      {draft && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
          <g transform={`translate(${offset.x} ${offset.y}) scale(${zoom})`}>
            <StrokeShape stroke={draft} />
          </g>
        </svg>
      )}
    </div>,
    container,
  )
}

export function DrawToolbarItem({ workspaceId, canvasId, canvasPanelId, tooltipPlacement }: CanvasToolbarItemProps) {
  const t = useT()
  const active = useCanvasUi((s) => s.activeTool === 'draw')
  const setActiveTool = useCanvasUi((s) => s.setActiveTool)
  const button = useRef<HTMLButtonElement>(null)
  const [card, setCard] = useState<HTMLElement | null>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) { setCard(null); setContainer(null); return }
    setCard(button.current?.closest<HTMLElement>('[data-toolbar-card]') ?? null)
    setContainer(canvasContainerFor(canvasId))
  }, [active, canvasId])

  // Putting the tool away ends the session: the next stroke starts a new
  // drawing. The hand tool (Space) is a pause, not an end.
  useEffect(() => useCanvasUi.subscribe((state, previous) => {
    if (previous.activeTool !== state.activeTool && state.activeTool === 'select') useDrawState.getState().setSession(null)
  }), [])

  return (
    <>
      <CanvasToolbarButton
        ref={button}
        onClick={() => setActiveTool(active ? 'select' : 'draw')}
        label={t('Draw')}
        active={active}
        tooltipPlacement={tooltipPlacement}
        className={active ? '!text-focus-blue' : ''}
      >
        <Pencil size={18} />
      </CanvasToolbarButton>
      {active && card && <DrawBar anchor={card} />}
      {active && container && <DrawSurface workspaceId={workspaceId} canvasId={canvasId} canvasPanelId={canvasPanelId} container={container} />}
    </>
  )
}
