// =============================================================================
// AgentCursorOverlay — shows what the agent is doing inside a browser panel.
//
// Agent input is delivered with sendInputEvent, which is byte-identical to a
// real user's input. Without this layer the page simply operates itself: fields
// fill, buttons depress, and the user has no idea what was targeted or why. This
// draws the missing pointer — a ghost cursor that moves to the target, a
// highlight around the element being acted on, and a label naming the action.
//
// It renders in the RENDERER, above the <webview>, not inside the guest page:
//  • the page cannot see, style or block it (an injected overlay can be hidden
//    by the site's own CSS, and breaks under a strict CSP),
//  • it survives navigation, and works over cross-origin frames,
//  • it never mutates the DOM the agent is measuring — an injected node would
//    change layout and hit-testing, i.e. change the thing being observed.
//
// Coordinates arrive in GUEST viewport pixels. The overlay is absolutely
// positioned over the webview's content box, so the mapping is 1:1 as long as
// the guest is not zoomed. `pointer-events: none` throughout — this layer must
// never intercept a click the user (or the agent) meant for the page.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import { subscribeAgentCursor, type AgentCursorEvent } from '../lib/browser/agentCursor'

/** How long the cursor stays on screen after the last action. Long enough to
 *  read the label, short enough that it doesn't linger over a page the user has
 *  taken back over. */
const IDLE_FADE_MS = 2_500
/** A click ripple's lifetime — purely decorative feedback for "it happened". */
const RIPPLE_MS = 600

interface Ripple { id: number; x: number; y: number; kind: AgentCursorEvent['kind'] }

export function AgentCursorOverlay({ panelId }: { panelId: string }): React.ReactElement | null {
  const [event, setEvent] = useState<AgentCursorEvent | null>(null)
  const [visible, setVisible] = useState(false)
  const [ripples, setRipples] = useState<Ripple[]>([])
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rippleSerial = useRef(0)

  useEffect(() => {
    return subscribeAgentCursor(panelId, (next) => {
      setEvent(next)
      setVisible(next.kind !== 'done')
      if (next.kind === 'click' || next.kind === 'dblclick') {
        const id = ++rippleSerial.current
        const { x, y, kind } = next
        if (typeof x === 'number' && typeof y === 'number') {
          setRipples((prev) => [...prev, { id, x, y, kind }])
          setTimeout(() => setRipples((prev) => prev.filter((r) => r.id !== id)), RIPPLE_MS)
        }
      }
      if (fadeTimer.current) clearTimeout(fadeTimer.current)
      fadeTimer.current = setTimeout(() => setVisible(false), IDLE_FADE_MS)
    })
  }, [panelId])

  useEffect(() => () => { if (fadeTimer.current) clearTimeout(fadeTimer.current) }, [])

  if (!event) return null

  const hasPoint = typeof event.x === 'number' && typeof event.y === 'number'
  const [boxLeft, boxTop, boxWidth, boxHeight] = event.rect ?? []

  return (
    <div
      className="absolute inset-0 z-30 overflow-hidden pointer-events-none"
      style={{ opacity: visible ? 1 : 0, transition: 'opacity 400ms ease-out' }}
      aria-hidden
    >
      {/* Standing "an agent is driving this panel" chip. The pointer and label
          come and go with each action; this stays for the whole burst, so the
          user is never left guessing whether the page is acting on its own. */}
      <div
        className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-semibold tracking-wide uppercase"
        style={{
          background: 'rgba(20,20,24,0.9)',
          color: '#4A9EFF',
          border: '1px solid rgba(74,158,255,0.5)',
          boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
        }}
      >
        <span
          style={{
            width: 6, height: 6, borderRadius: 999, background: '#4A9EFF',
            animation: 'cate-agent-pulse 1.4s ease-in-out infinite',
          }}
        />
        Agent
      </div>

      {/* Target highlight — the element the action is aimed at. */}
      {event.rect && (
        <div
          className="absolute rounded-[4px]"
          style={{
            left: boxLeft,
            top: boxTop,
            width: boxWidth,
            height: boxHeight,
            border: '2px solid rgba(74,158,255,0.9)',
            boxShadow: '0 0 0 3px rgba(74,158,255,0.18), 0 2px 12px rgba(74,158,255,0.35)',
            background: 'rgba(74,158,255,0.08)',
            transition: 'left 180ms ease-out, top 180ms ease-out, width 180ms, height 180ms',
          }}
        />
      )}

      {/* Drag path — a dashed line from origin to destination. */}
      {event.kind === 'drag' && hasPoint && typeof event.toX === 'number' && typeof event.toY === 'number' && (
        <svg className="absolute inset-0 w-full h-full">
          <line
            x1={event.x} y1={event.y} x2={event.toX} y2={event.toY}
            stroke="rgba(74,158,255,0.75)" strokeWidth={2} strokeDasharray="6 4"
          />
          <circle cx={event.toX} cy={event.toY} r={5} fill="rgba(74,158,255,0.9)" />
        </svg>
      )}

      {/* Click ripples. */}
      {ripples.map((ripple) => (
        <div
          key={ripple.id}
          className="absolute rounded-full"
          style={{
            left: ripple.x, top: ripple.y,
            width: 12, height: 12, marginLeft: -6, marginTop: -6,
            border: '2px solid rgba(74,158,255,0.9)',
            animation: `cate-agent-ripple ${RIPPLE_MS}ms ease-out forwards`,
          }}
        />
      ))}

      {/* The pointer + its label. Positioned at the action point; falls back to
          the top-left corner for actions with no coordinate (a bare keypress),
          because the label still tells the user what is happening. */}
      <div
        className="absolute flex items-start gap-1.5"
        style={{
          left: hasPoint ? event.x : 12,
          top: hasPoint ? event.y : 12,
          transition: 'left 220ms cubic-bezier(0.22, 1, 0.36, 1), top 220ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {hasPoint && (
          // Arrow pointer, drawn rather than an emoji/system cursor so it looks
          // identical on every platform and reads as "not your cursor".
          <svg width="18" height="22" viewBox="0 0 18 22" style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.5))' }}>
            <path d="M2 1 L2 17 L6.2 13.2 L9 20 L12 18.6 L9.2 12 L14.5 12 Z" fill="#4A9EFF" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        )}
        <span
          className="mt-3 px-2 py-1 rounded-md text-[11px] font-medium whitespace-nowrap"
          style={{
            background: 'rgba(20,20,24,0.92)',
            color: '#EDEDF0',
            border: '1px solid rgba(74,158,255,0.55)',
            boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
          }}
        >
          {event.label}
        </span>
      </div>

      <style>{`
        @keyframes cate-agent-ripple {
          from { transform: scale(1); opacity: 0.9; }
          to { transform: scale(3.4); opacity: 0; }
        }
        @keyframes cate-agent-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.25; }
        }
      `}</style>
    </div>
  )
}
