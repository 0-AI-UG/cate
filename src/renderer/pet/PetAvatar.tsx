// =============================================================================
// PetAvatar — the Canvas Pet's on-canvas presence.
//
// Two renderers, mutually exclusive by activity:
//   - PetWorldAvatar: rendered INSIDE the canvas world transform (Canvas.tsx), so
//     it tracks a terminal node exactly under pan/zoom. Shown whenever the pet is
//     tethered to a node: the executor "sits" at the terminal it's driving, and
//     the observer "sits" at whatever terminal it's currently reading.
//   - PetCornerAvatar (exported as PetAvatar): a screen-space companion that rests
//     in a bottom corner (away from the minimap) for the resting / paused states
//     and for an observe turn before it has read any terminal.
//
// Both reflect the arbitrated activity via color + a busy bob and carry the
// status bubble. Clicking the idle corner pet kicks off an observe run; the
// tethered world avatar opens the Tasks panel.
// =============================================================================

import React from 'react'
import { useAppStore } from '../stores/appStore'
import { useUIStore, getSidebarLayout } from '../stores/uiStore'
import { useUIStateStore } from '../stores/uiStateStore'
import { useCanvasStoreContext } from '../stores/CanvasStoreContext'
import { usePetWs } from './petStore'
import { petController } from './petController'
import { cornerFromPoint, nextFreeCorner } from '../lib/canvasCorners'
import { viewToCanvas } from '../lib/canvas/coordinates'
import type { CanvasCorner, PetActivity, Point } from '../../shared/types'

const COLOR: Record<PetActivity, string> = {
  off: 'var(--surface-5)',
  resting: 'var(--surface-5)',
  observing: '#60a5fa',
  working: '#4ade80',
  paused: '#fbbf24',
}

const LABEL: Record<PetActivity, string> = {
  off: 'Off',
  resting: 'Resting',
  observing: 'Looking around…',
  working: 'Working',
  paused: 'Paused',
}

const KEYFRAMES = `
  @keyframes pet-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-3px) } }
  @keyframes pet-idle { 0%,100% { transform: translateY(0) rotate(-2.5deg) } 50% { transform: translateY(-5px) rotate(2.5deg) } }
  @keyframes pet-blink { 0%,92%,100% { transform: scaleY(1) } 96% { transform: scaleY(0.1) } }
  @keyframes pet-hop {
    0%   { transform: translateY(0) scaleX(1) scaleY(1) }
    18%  { transform: translateY(0) scaleX(1.28) scaleY(0.78) }
    42%  { transform: translateY(-14px) scaleX(0.82) scaleY(1.2) }
    62%  { transform: translateY(-14px) scaleX(0.88) scaleY(1.14) }
    82%  { transform: translateY(0) scaleX(1.28) scaleY(0.78) }
    100% { transform: translateY(0) scaleX(1) scaleY(1) }
  }
  .pet-idle { animation: pet-idle 2.8s ease-in-out infinite; }
  .pet-idle:hover { animation: pet-hop 0.7s ease-in-out infinite; }
`

function openTasks(): void {
  const layout = getSidebarLayout()
  if (layout.left.includes('tasks')) useUIStore.getState().setActiveLeftSidebarView('tasks')
  else useUIStore.getState().setActiveRightSidebarView('tasks')
}

// --- shared bits ------------------------------------------------------------

const PetBubble: React.FC<{ text: string; remark?: boolean }> = ({ text, remark }) => (
  <div
    className={`pointer-events-none max-w-[240px] border border-strong bg-surface-1/95 px-2.5 py-1 text-[11px] shadow-md ${
      remark ? 'whitespace-normal break-words rounded-2xl text-primary' : 'truncate rounded-full text-secondary'
    }`}
  >
    {text}
  </div>
)

const PetButton: React.FC<{
  activity: PetActivity
  onClick?: () => void
  onMouseDown?: (e: React.MouseEvent) => void
}> = ({ activity, onClick, onMouseDown }) => {
  const color = COLOR[activity] ?? COLOR.resting
  const busy = activity === 'working' || activity === 'observing'
  const idle = activity === 'resting'
  // Idle pet keeps a gentle float-sway (the `.pet-idle` class) that turns into a
  // cute wiggle on hover; busy keeps its tighter working bob (inline). Other
  // states (paused/off) just get the plain hover-scale.
  return (
    <button
      onClick={onClick}
      onMouseDown={onMouseDown}
      title={`Canvas Pet — ${LABEL[activity]}`}
      className={`pointer-events-auto relative flex items-center justify-center rounded-2xl border border-strong shadow-lg transition-transform ${idle ? 'pet-idle' : 'hover:scale-105'}`}
      style={{
        width: 40,
        height: 40,
        backgroundColor: 'var(--surface-1)',
        boxShadow: `0 0 0 2px color-mix(in srgb, ${color} 50%, transparent)`,
        animation: busy ? 'pet-bob 1.4s ease-in-out infinite' : undefined,
        cursor: onMouseDown ? 'grab' : undefined,
      }}
    >
      <PetFace color={color} activity={activity} />
    </button>
  )
}

const PetFace: React.FC<{ color: string; activity: PetActivity }> = ({ color, activity }) => {
  // Only a paused pet "sleeps" (closed eyes). Idle/resting stays awake and
  // blinking so doing-nothing still looks alive.
  const sleeping = activity === 'paused'
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
      <rect x="3" y="4" width="20" height="18" rx="7" fill={color} opacity="0.92" />
      {sleeping ? (
        <>
          <path d="M8 13 h4" stroke="#0b0b0f" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M14 13 h4" stroke="#0b0b0f" strokeWidth="1.6" strokeLinecap="round" />
        </>
      ) : (
        <g style={{ transformOrigin: 'center', animation: 'pet-blink 4s infinite' }}>
          <circle cx="10" cy="12" r="2" fill="#0b0b0f" />
          <circle cx="16" cy="12" r="2" fill="#0b0b0f" />
        </g>
      )}
    </svg>
  )
}

// --- corner companion (App, screen space) -----------------------------------

// Tracks the live screen rect of the canvas drawing area (the container the
// minimap pill also lives in) so the resting pet docks to the SAME corners as
// the minimap, regardless of sidebars / dock chrome around the canvas.
function useCanvasAreaRect(wsId: string | null): DOMRect | null {
  const [rect, setRect] = React.useState<DOMRect | null>(null)
  React.useEffect(() => {
    let raf = 0
    let tries = 0
    let ro: ResizeObserver | null = null
    const attach = () => {
      const el = document.querySelector('[data-canvas-area]') as HTMLElement | null
      if (!el) {
        if (tries++ < 60) raf = requestAnimationFrame(attach)
        return
      }
      // ResizeObserver fires once immediately on observe, and again whenever the
      // area changes size (window resize, sidebar toggles shrink the flex child).
      ro = new ResizeObserver(() => setRect(el.getBoundingClientRect()))
      ro.observe(el)
    }
    attach()
    return () => { cancelAnimationFrame(raf); ro?.disconnect() }
  }, [wsId])
  return rect
}

export const PetAvatar: React.FC = () => {
  const wsId = useAppStore((s) => s.selectedWorkspaceId)
  const pet = usePetWs(wsId)
  // The draggable minimap is the toolbar pill, docked via `minimapButtonCorner`.
  const minimapCorner = useUIStateStore((s) => s.minimapButtonCorner)
  const petCorner = useUIStateStore((s) => s.petCorner)
  const areaRect = useCanvasAreaRect(wsId)
  // Tracks whether the current press turned into a drag, so the trailing click
  // doesn't also open the Tasks panel.
  const draggedRef = React.useRef(false)

  // Hidden when not summoned, and whenever the world avatar is tethered to a node
  // (executor working, or observer reading a terminal) so the two never show at
  // once.
  if (!pet.enabled) return null
  if ((pet.activity === 'working' || pet.activity === 'observing') && pet.focusNodeId) return null

  // The pet docks in its own corner. If it ends up sharing the minimap's corner
  // (e.g. stale persisted state), bounce it to the next free corner so it never
  // covers the minimap.
  const corner: CanvasCorner = petCorner === minimapCorner ? nextFreeCorner(petCorner, minimapCorner) : petCorner
  const onRight = corner.endsWith('right')
  const onBottom = corner.startsWith('bottom')

  // Anchor to the canvas area's corners (fixed = viewport coords). Falls back to
  // the whole viewport until the area is measured.
  const rect = areaRect ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight } as DOMRect
  const INSET = 16
  const pos: React.CSSProperties = {
    position: 'fixed',
    ...(onRight ? { right: window.innerWidth - rect.right + INSET } : { left: rect.left + INSET }),
    ...(onBottom ? { bottom: window.innerHeight - rect.bottom + INSET } : { top: rect.top + INSET }),
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    // Detect against the same canvas-area rect the minimap uses so both agree on
    // which corner a point belongs to.
    const startX = e.clientX
    const startY = e.clientY
    draggedRef.current = false
    const move = (ev: MouseEvent) => {
      if (!draggedRef.current && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
      draggedRef.current = true
      const next = cornerFromPoint(ev.clientX, ev.clientY, rect)
      const store = useUIStateStore.getState()
      const prev = store.petCorner
      if (next === prev) return
      store.setUIState('petCorner', next)
      // Landing on the minimap's corner swaps the minimap into the corner we just left.
      if (next === store.minimapButtonCorner) {
        store.setUIState('minimapButtonCorner', prev)
      }
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const handleClick = () => {
    if (draggedRef.current) { draggedRef.current = false; return }
    // Poking the idle pet kicks off an observe run now (bypassing the 60s gate);
    // a paused pet has nothing to look at, so it falls back to opening Tasks.
    if (pet.activity === 'resting' && wsId) petController.observeNow(wsId)
    else openTasks()
  }

  const busy = pet.activity === 'observing'
  return (
    <div className="z-30 pointer-events-none select-none" style={pos}>
      <div className={`flex ${onBottom ? 'flex-col' : 'flex-col-reverse'} gap-1 ${onRight ? 'items-end' : 'items-start'}`}>
        {pet.remark && <PetBubble text={pet.remark} remark />}
        {(pet.status || busy) && <PetBubble text={pet.status || LABEL[pet.activity]} />}
        <PetButton activity={pet.activity} onClick={handleClick} onMouseDown={handleMouseDown} />
      </div>
      <style>{KEYFRAMES}</style>
    </div>
  )
}

// --- world avatar (Canvas world layer, canvas space) ------------------------

const TRAVEL_MS = 600

// Where the idle corner pet sits, expressed in canvas space — the origin the
// world avatar slides out FROM when it first tethers to a terminal. Mirrors the
// corner avatar's screen placement (data-canvas-area inset), then inverts the
// world transform so the canvas point lands under that same screen pixel.
function cornerCanvasPoint(corner: CanvasCorner, zoom: number, offset: Point): Point {
  const el = document.querySelector('[data-canvas-area]') as HTMLElement | null
  const w = el?.clientWidth ?? window.innerWidth
  const h = el?.clientHeight ?? window.innerHeight
  const INSET = 16
  const HALF = 20 // half the 40px button, so we aim at its centre
  const localX = corner.endsWith('right') ? w - INSET - HALF : INSET + HALF
  const localY = corner.startsWith('bottom') ? h - INSET - HALF : INSET + HALF
  return viewToCanvas({ x: localX, y: localY }, zoom, offset)
}

export const PetWorldAvatar: React.FC = () => {
  const wsId = useAppStore((s) => s.selectedWorkspaceId)
  const pet = usePetWs(wsId)
  const nodes = useCanvasStoreContext((s) => s.nodes)
  const zoom = useCanvasStoreContext((s) => s.zoomLevel)
  const offset = useCanvasStoreContext((s) => s.viewportOffset)
  const petCorner = useUIStateStore((s) => s.petCorner)

  // Tethered while the executor works, or while the observer is sitting on the
  // terminal it's reading. focusNodeId is the terminal's panelId in both cases.
  const tethered = pet.activity === 'working' || pet.activity === 'observing'
  // focusNodeId is the terminal's panelId; find its node in THIS canvas (a node
  // only exists here for the canvas that actually holds the terminal, so nested
  // canvases naturally render nothing).
  const node = pet.focusNodeId ? Object.values(nodes).find((n) => n.panelId === pet.focusNodeId) : undefined
  const visible = pet.enabled && tethered && !!node
  const target: Point | null = node ? { x: node.origin.x + node.size.width, y: node.origin.y } : null

  // Animated position. `moving` toggles the CSS slide on only during a travel so
  // that tracking the same terminal (drag/resize) still snaps instantly.
  const [pos, setPos] = React.useState<Point | null>(null)
  const [moving, setMoving] = React.useState(false)
  const posRef = React.useRef<Point | null>(null)
  posRef.current = pos
  const prevNodeIdRef = React.useRef<string | null>(null)
  // Read fresh on entrance only, so panning (which churns offset every frame)
  // doesn't re-run the travel effect.
  const originRef = React.useRef({ corner: petCorner, zoom, offset })
  originRef.current = { corner: petCorner, zoom, offset }

  React.useLayoutEffect(() => {
    if (!visible || !target || !node) {
      prevNodeIdRef.current = null
      setPos(null)
      setMoving(false)
      return
    }
    const id = node.panelId
    if (prevNodeIdRef.current === id) {
      // Same terminal — follow drags/resizes instantly, no slide.
      setMoving(false)
      setPos(target)
      return
    }
    // New tether (slide in from the idle corner) or a hop to a different terminal
    // (slide from where we currently are). Commit the origin before paint, then
    // turn the transition on and move to the target on the next frame.
    const { corner, zoom, offset } = originRef.current
    const origin = prevNodeIdRef.current == null ? cornerCanvasPoint(corner, zoom, offset) : posRef.current ?? target
    prevNodeIdRef.current = id
    setMoving(false)
    setPos(origin)
    const raf = requestAnimationFrame(() => {
      setMoving(true)
      setPos(target)
    })
    const t = setTimeout(() => setMoving(false), TRAVEL_MS)
    return () => { cancelAnimationFrame(raf); clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, node?.panelId, target?.x, target?.y])

  if (!visible || !target) return null
  const at = pos ?? target

  return (
    <div
      style={{
        position: 'absolute',
        left: at.x,
        top: at.y,
        // Overshoot ease so the pet lands with a little spring at its destination.
        transition: moving ? `left ${TRAVEL_MS}ms cubic-bezier(0.34, 1.3, 0.5, 1), top ${TRAVEL_MS}ms cubic-bezier(0.34, 1.3, 0.5, 1)` : undefined,
        zIndex: 100000,
        pointerEvents: 'none',
      }}
    >
      {/* No counter-scale: the avatar lives inside the canvas world transform, so
          it scales with zoom right alongside the terminal it's sitting on. The
          idle corner avatar stays screen-space (constant size); only the tethered
          world avatar tracks zoom. */}
      <div style={{ transform: 'translate(-48px, -54px)' }} className="flex flex-col items-start gap-1">
        {pet.remark && <PetBubble text={pet.remark} remark />}
        {pet.status && <PetBubble text={pet.status} />}
        <PetButton activity={pet.activity} onClick={openTasks} />
      </div>
      <style>{KEYFRAMES}</style>
    </div>
  )
}
