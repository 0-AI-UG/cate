// =============================================================================
// CateAgentAvatar — the Cate Agent's screen-space companion.
//
// A single avatar that rests in a bottom corner of the canvas area (away from the
// minimap). It never moves onto the canvas; it just reflects the arbitrated activity
// via color + a busy bob and carries the status/remark bubble. Clicking the idle
// Cate Agent kicks off an observe run; clicking it while busy opens the Tasks panel.
// =============================================================================

import React from 'react'
import { useAppStore } from '../stores/appStore'
import { useUIStore, getSidebarLayout } from '../stores/uiStore'
import { useUIStateStore } from '../stores/uiStateStore'
import { useCateAgentWs, useCateAgentStore, type CateAgentRemark } from './cateAgentStore'
import { cateAgentController } from './cateAgentController'
import { cornerFromPoint, nextFreeCorner } from '../lib/canvasCorners'
import { CateLogo } from '../ui/CateLogo'
import type { CanvasCorner, CateAgentActivity } from '../../shared/types'

const COLOR: Record<CateAgentActivity, string> = {
  off: 'var(--surface-5)',
  resting: 'var(--surface-5)',
  observing: '#60a5fa',
  working: '#4ade80',
}

const LABEL: Record<CateAgentActivity, string> = {
  off: 'Off',
  resting: 'Taking a breather',
  observing: 'Reading your terminals',
  working: 'On a task',
}

const KEYFRAMES = `
  @keyframes cate-agent-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-3px) } }
  @keyframes cate-agent-idle { 0%,100% { transform: translateY(0) rotate(-2.5deg) } 50% { transform: translateY(-5px) rotate(2.5deg) } }
  @keyframes cate-agent-hop {
    0%   { transform: translateY(0) scaleX(1) scaleY(1) }
    18%  { transform: translateY(0) scaleX(1.28) scaleY(0.78) }
    42%  { transform: translateY(-14px) scaleX(0.82) scaleY(1.2) }
    62%  { transform: translateY(-14px) scaleX(0.88) scaleY(1.14) }
    82%  { transform: translateY(0) scaleX(1.28) scaleY(0.78) }
    100% { transform: translateY(0) scaleX(1) scaleY(1) }
  }
  /* Bubble float mirrors the Cate Agent's vertical motion so the speech bubble bobs
     in sync with it: -3px at the busy cadence, the gentler idle rise otherwise. */
  @keyframes cate-agent-bubble-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-3px) } }
  @keyframes cate-agent-bubble-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-5px) } }
  .cate-agent-idle { animation: cate-agent-idle 2.8s ease-in-out infinite; }
  .cate-agent-idle:hover { animation: cate-agent-hop 0.7s ease-in-out infinite; }
`

const bubbleBob = (busy: boolean): string =>
  busy ? 'cate-agent-bubble-bob 1.4s ease-in-out infinite' : 'cate-agent-bubble-float 2.8s ease-in-out infinite'

function openTasks(): void {
  const layout = getSidebarLayout()
  if (layout.left.includes('tasks')) useUIStore.getState().setActiveLeftSidebarView('tasks')
  else useUIStore.getState().setActiveRightSidebarView('tasks')
}

// --- shared bits ------------------------------------------------------------

// A little speech bubble that bobs in sync with the Cate Agent. `align` keeps the
// tail under the avatar's side. Remarks read as the Cate Agent "speaking" (primary
// text); the activity status is quieter (secondary).
const CateAgentBubble: React.FC<{
  text: string
  remark?: boolean
  bob: string
  /** When set, the bubble is clickable and calling it dismisses this remark. */
  onPop?: () => void
}> = ({ text, remark, bob, onPop }) => (
  <div className={`relative ${onPop ? 'pointer-events-auto' : 'pointer-events-none'}`} style={{ animation: bob }}>
    <div
      onClick={onPop}
      title={onPop ? 'Dismiss' : undefined}
      className={`w-max max-w-[240px] whitespace-normal break-words rounded-2xl border border-strong bg-surface-1/95 px-3 py-1.5 text-[11px] leading-snug shadow-md ${
        remark ? 'text-primary' : 'text-secondary'
      } ${onPop ? 'cursor-pointer transition-colors hover:bg-hover-strong' : ''}`}
    >
      {text}
    </div>
  </div>
)

// The speech-bubble area: a stack of remarks (newest nearest the avatar) while any
// linger, otherwise the single activity status. Absolutely positioned off the avatar
// so it grows AWAY from it.
const CateAgentBubbleStack: React.FC<{
  wsId: string
  remarks: CateAgentRemark[]
  status: string
  bob: string
  /** Stack sits above the avatar vs below it. */
  above: boolean
  align: 'left' | 'right'
}> = ({ wsId, remarks, status, bob, above, align }) => {
  // Remarks are user-dismissable (id carried so a click pops exactly that one);
  // the activity status is not — it reflects live state and isn't a remark.
  const items: Array<{ key: string; text: string; remark: boolean; id: number | null }> = remarks.length
    ? remarks.map((r) => ({ key: String(r.id), text: r.text, remark: true, id: r.id }))
    : status
      ? [{ key: 'status', text: status, remark: false, id: null }]
      : []
  if (!items.length) return null
  // Newest sits nearest the avatar: that's the last child when the stack grows upward,
  // the first when it grows downward — so reverse for the downward case.
  const ordered = above ? items : [...items].reverse()
  return (
    <div
      className={`absolute flex flex-col gap-1.5 ${above ? 'bottom-full mb-1.5' : 'top-full mt-1.5'} ${
        align === 'right' ? 'right-0 items-end' : 'left-0 items-start'
      }`}
    >
      {ordered.map((b) => (
        <CateAgentBubble
          key={b.key}
          text={b.text}
          remark={b.remark}
          bob={bob}
          onPop={b.id != null ? () => useCateAgentStore.getState().popRemark(wsId, b.id as number) : undefined}
        />
      ))}
    </div>
  )
}

const CateAgentButton: React.FC<{
  activity: CateAgentActivity
  onClick?: () => void
  onMouseDown?: (e: React.MouseEvent) => void
}> = ({ activity, onClick, onMouseDown }) => {
  const color = COLOR[activity] ?? COLOR.resting
  const busy = activity === 'working' || activity === 'observing'
  const idle = activity === 'resting'
  // Idle Cate Agent keeps a gentle float-sway (the `.cate-agent-idle` class) that
  // turns into a cute wiggle on hover; busy keeps its tighter working bob (inline).
  // The off state just gets the plain hover-scale.
  return (
    <button
      onClick={onClick}
      onMouseDown={onMouseDown}
      title={`Cate Agent — ${LABEL[activity]}`}
      className={`pointer-events-auto relative flex items-center justify-center rounded-2xl border border-strong shadow-lg transition-transform ${idle ? 'cate-agent-idle' : 'hover:scale-105'}`}
      style={{
        width: 40,
        height: 40,
        backgroundColor: 'var(--surface-1)',
        boxShadow: `0 0 0 2px color-mix(in srgb, ${color} 50%, transparent)`,
        animation: busy ? 'cate-agent-bob 1.4s ease-in-out infinite' : undefined,
        cursor: onMouseDown ? 'grab' : undefined,
      }}
    >
      <CateLogo size={26} />
    </button>
  )
}

// --- corner companion (App, screen space) -----------------------------------

// Tracks the live screen rect of the canvas drawing area (the container the
// minimap pill also lives in) so the resting Cate Agent docks to the SAME corners
// as the minimap, regardless of sidebars / dock chrome around the canvas.
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

export const CateAgentAvatar: React.FC = () => {
  const wsId = useAppStore((s) => s.selectedWorkspaceId)
  const cateAgent = useCateAgentWs(wsId)
  // The draggable minimap is the toolbar pill, docked via `minimapButtonCorner`.
  const minimapCorner = useUIStateStore((s) => s.minimapButtonCorner)
  const cateAgentCorner = useUIStateStore((s) => s.cateAgentCorner)
  const areaRect = useCanvasAreaRect(wsId)
  // Tracks whether the current press turned into a drag, so the trailing click
  // doesn't also open the Tasks panel.
  const draggedRef = React.useRef(false)

  if (!cateAgent.enabled) return null

  // The Cate Agent docks in its own corner. If it ends up sharing the minimap's
  // corner (e.g. stale persisted state), bounce it to the next free corner so it
  // never covers the minimap.
  const corner: CanvasCorner = cateAgentCorner === minimapCorner ? nextFreeCorner(cateAgentCorner, minimapCorner) : cateAgentCorner
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
      const prev = store.cateAgentCorner
      if (next === prev) return
      store.setUIState('cateAgentCorner', next)
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
    // Poking the idle Cate Agent kicks off an observe run now (bypassing the 60s
    // gate); any other state falls back to opening Tasks.
    if (cateAgent.activity === 'resting' && wsId) cateAgentController.observeNow(wsId)
    else openTasks()
  }

  const busy = cateAgent.activity === 'observing'
  // Remarks (if any) take over the bubble area; otherwise the activity status,
  // falling back to a label when busy with nothing more specific to say. The stack
  // sits above the avatar on bottom corners (tail down) and below it on top corners.
  const statusText = cateAgent.status || (busy ? LABEL[cateAgent.activity] : '')
  return (
    <div className="z-30 pointer-events-none select-none" style={pos}>
      <div className="relative">
        <CateAgentButton activity={cateAgent.activity} onClick={handleClick} onMouseDown={handleMouseDown} />
        <CateAgentBubbleStack
          wsId={wsId ?? ''}
          remarks={cateAgent.remarks}
          status={statusText}
          bob={bubbleBob(busy)}
          above={onBottom}
          align={onRight ? 'right' : 'left'}
        />
      </div>
      <style>{KEYFRAMES}</style>
    </div>
  )
}
