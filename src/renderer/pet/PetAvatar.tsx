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
// Both reflect the arbitrated activity via color + a busy bob, carry the status
// bubble, and open the Tasks panel on click.
// =============================================================================

import React from 'react'
import { useAppStore } from '../stores/appStore'
import { useUIStore, getSidebarLayout } from '../stores/uiStore'
import { useUIStateStore } from '../stores/uiStateStore'
import { useCanvasStoreContext } from '../stores/CanvasStoreContext'
import { usePetWs } from './petStore'
import { cornerFromPoint, nextFreeCorner } from '../lib/canvasCorners'
import type { CanvasCorner, PetActivity } from '../../shared/types'

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
  @keyframes pet-blink { 0%,92%,100% { transform: scaleY(1) } 96% { transform: scaleY(0.1) } }
`

function openTasks(): void {
  const layout = getSidebarLayout()
  if (layout.left.includes('tasks')) useUIStore.getState().setActiveLeftSidebarView('tasks')
  else useUIStore.getState().setActiveRightSidebarView('tasks')
}

// --- shared bits ------------------------------------------------------------

const PetBubble: React.FC<{ text: string }> = ({ text }) => (
  <div className="pointer-events-none max-w-[240px] truncate rounded-full bg-surface-1/95 border border-strong px-2.5 py-1 text-[11px] text-secondary shadow-md">
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
  return (
    <button
      onClick={onClick}
      onMouseDown={onMouseDown}
      title={`Canvas Pet — ${LABEL[activity]}`}
      className="pointer-events-auto relative flex items-center justify-center rounded-2xl border border-strong shadow-lg transition-transform hover:scale-105"
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
  const sleeping = activity === 'resting' || activity === 'paused'
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

export const PetAvatar: React.FC = () => {
  const wsId = useAppStore((s) => s.selectedWorkspaceId)
  const pet = usePetWs(wsId)
  // The draggable minimap is the toolbar pill, docked via `minimapButtonCorner`.
  const minimapCorner = useUIStateStore((s) => s.minimapButtonCorner)
  const petCorner = useUIStateStore((s) => s.petCorner)
  const wrapRef = React.useRef<HTMLDivElement>(null)
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
  const pos = {
    ...(onRight ? { right: 16 } : { left: 16 }),
    ...(onBottom ? { bottom: 16 } : { top: 16 }),
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    // Resolve quadrants against the full window, matching the minimap pill, so
    // both agree on which corner a point belongs to.
    const startX = e.clientX
    const startY = e.clientY
    draggedRef.current = false
    const move = (ev: MouseEvent) => {
      if (!draggedRef.current && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
      draggedRef.current = true
      const next = cornerFromPoint(ev.clientX, ev.clientY, {
        left: 0, top: 0, width: window.innerWidth, height: window.innerHeight,
      })
      const store = useUIStateStore.getState()
      if (next === store.petCorner) return
      store.setUIState('petCorner', next)
      // Landing on the minimap's corner shoves the minimap to the next free one.
      if (next === store.minimapButtonCorner) {
        store.setUIState('minimapButtonCorner', nextFreeCorner(store.minimapButtonCorner, next))
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
    openTasks()
  }

  const busy = pet.activity === 'observing'
  return (
    <div ref={wrapRef} className="absolute z-30 pointer-events-none select-none" style={pos}>
      <div className={`flex ${onBottom ? 'flex-col' : 'flex-col-reverse'} gap-1 ${onRight ? 'items-end' : 'items-start'}`}>
        {(pet.status || busy) && <PetBubble text={pet.status || LABEL[pet.activity]} />}
        <PetButton activity={pet.activity} onClick={handleClick} onMouseDown={handleMouseDown} />
      </div>
      <style>{KEYFRAMES}</style>
    </div>
  )
}

// --- world avatar (Canvas world layer, canvas space) ------------------------

export const PetWorldAvatar: React.FC = () => {
  const wsId = useAppStore((s) => s.selectedWorkspaceId)
  const pet = usePetWs(wsId)
  const nodes = useCanvasStoreContext((s) => s.nodes)
  const zoom = useCanvasStoreContext((s) => s.zoomLevel)

  // Tethered while the executor works, or while the observer is sitting on the
  // terminal it's reading. focusNodeId is the terminal's panelId in both cases.
  const tethered = pet.activity === 'working' || pet.activity === 'observing'
  if (!pet.enabled || !tethered || !pet.focusNodeId) return null
  // focusNodeId is the terminal's panelId; find its node in THIS canvas (a node
  // only exists here for the canvas that actually holds the terminal, so nested
  // canvases naturally render nothing).
  const node = Object.values(nodes).find((n) => n.panelId === pet.focusNodeId)
  if (!node) return null

  return (
    <div
      style={{
        position: 'absolute',
        left: node.origin.x + node.size.width,
        top: node.origin.y,
        zIndex: 100000,
        pointerEvents: 'none',
      }}
    >
      {/* Counter-scale so the avatar stays a constant screen size regardless of
          zoom while its anchor tracks the node under the world transform. */}
      <div style={{ transform: `scale(${1 / zoom})`, transformOrigin: 'top left' }}>
        <div style={{ transform: 'translate(-48px, -54px)' }} className="flex flex-col items-start gap-1">
          {pet.status && <PetBubble text={pet.status} />}
          <PetButton activity={pet.activity} onClick={openTasks} />
        </div>
      </div>
      <style>{KEYFRAMES}</style>
    </div>
  )
}
