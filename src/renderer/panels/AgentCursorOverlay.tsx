// =============================================================================
// AgentCursorOverlay — shows what the agent is doing inside a browser panel.
//
// Agent input is delivered with sendInputEvent, which is byte-identical to a
// real user's input. Without this layer the page simply operates itself: fields
// fill, buttons depress, and the user has no idea what was targeted or why. This
// draws the missing pointer — a ghost cursor that moves to the target and
// communicates actions through motion instead of exposing command text.
//
// It renders in the RENDERER, above the <webview>, not inside the guest page:
//  • the page cannot see, style or block it (an injected overlay can be hidden
//    by the site's own CSS, and breaks under a strict CSP),
//  • it survives navigation, and works over cross-origin frames,
//  • it never mutates the DOM the agent is measuring — an injected node would
//    change layout and hit-testing, i.e. change the thing being observed.
//
// Coordinates arrive in GUEST viewport pixels. BrowserPanel passes the combined
// page-zoom and fit-to-panel scale used by the webview. `pointer-events: none`
// throughout — this layer must never intercept a click the user (or the agent)
// meant for the page.
// =============================================================================

import { useEffect, useId, useRef, useState } from 'react'
import { subscribeAgentCursor, type AgentCursorEvent } from '../lib/browser/agentCursor'

/** A click ripple's lifetime — purely decorative feedback for "it happened". */
const RIPPLE_MS = 600

interface Ripple { id: number; x: number; y: number; delay: number }

export function AgentCursorOverlay({
  panelId,
  scale = 1,
  onVisibilityChange,
}: {
  panelId: string
  scale?: number
  onVisibilityChange?: (visible: boolean) => void
}): React.ReactElement | null {
  const [event, setEvent] = useState<AgentCursorEvent | null>(null)
  const [visible, setVisible] = useState(false)
  const [ripples, setRipples] = useState<Ripple[]>([])
  const [activitySerial, setActivitySerial] = useState(0)
  const rippleSerial = useRef(0)
  const pointerGradientId = useId()

  useEffect(() => {
    const unsubscribe = subscribeAgentCursor(panelId, (next) => {
      setEvent((previous) => next.kind === 'done'
        ? next
        : {
            ...next,
            x: next.x ?? previous?.x,
            y: next.y ?? previous?.y,
          })
      const nextVisible = next.kind !== 'done'
      setVisible(nextVisible)
      onVisibilityChange?.(nextVisible)
      setActivitySerial((serial) => serial + 1)
      if (next.kind === 'click' || next.kind === 'dblclick') {
        const { x, y } = next
        if (typeof x === 'number' && typeof y === 'number') {
          const count = next.kind === 'dblclick' ? 2 : 1
          for (let index = 0; index < count; index += 1) {
            const id = ++rippleSerial.current
            const delay = index * 120
            setRipples((prev) => [...prev, { id, x, y, delay }])
            setTimeout(
              () => setRipples((prev) => prev.filter((ripple) => ripple.id !== id)),
              RIPPLE_MS + delay,
            )
          }
        }
      }
    })
    return () => {
      unsubscribe()
      onVisibilityChange?.(false)
    }
  }, [panelId, onVisibilityChange])

  if (!event) return null

  const hasPoint = typeof event.x === 'number' && typeof event.y === 'number'
  const pointX = typeof event.x === 'number' ? event.x * scale : undefined
  const pointY = typeof event.y === 'number' ? event.y * scale : undefined
  const pointerAnimation = event.kind === 'click' || event.kind === 'dblclick'
    ? 'cate-agent-pointer-click 220ms ease-out'
    : event.kind === 'type' || event.kind === 'press'
      ? 'cate-agent-pointer-type 520ms ease-out'
      : event.kind === 'scroll'
        ? 'cate-agent-pointer-scroll 520ms ease-in-out'
        : event.kind === 'hover'
          ? 'cate-agent-pointer-hover 700ms ease-in-out'
          : undefined

  return (
    <div
      className="absolute inset-0 z-30 overflow-hidden pointer-events-none"
      style={{ opacity: visible ? 1 : 0, transition: 'opacity 400ms ease-out' }}
      aria-hidden
    >
      {/* Drag path — a dashed line from origin to destination. */}
      {event.kind === 'drag' && hasPoint && typeof event.toX === 'number' && typeof event.toY === 'number' && (
        <svg className="absolute inset-0 w-full h-full">
          <line
            x1={pointX} y1={pointY} x2={event.toX * scale} y2={event.toY * scale}
            stroke="rgba(74,158,255,0.75)" strokeWidth={2} strokeDasharray="6 4"
          />
          <circle cx={event.toX * scale} cy={event.toY * scale} r={5} fill="rgba(74,158,255,0.9)" />
        </svg>
      )}

      {/* Click ripples. */}
      {ripples.map((ripple) => (
        <div
          key={ripple.id}
          data-agent-effect="click"
          className="absolute rounded-full"
          style={{
            left: ripple.x * scale, top: ripple.y * scale,
            width: 12, height: 12, marginLeft: -6, marginTop: -6,
            border: '2px solid rgba(74,158,255,0.9)',
            animation: `cate-agent-ripple ${RIPPLE_MS}ms ease-out forwards`,
            animationDelay: `${ripple.delay}ms`,
            animationFillMode: 'both',
          }}
        />
      ))}

      {/* The pointer. Action feedback is visual only: click rings and pointer
          motion. Command labels/selectors stay out of the UI. */}
      {hasPoint && (
        <div
          data-agent-cursor
          className="absolute"
          style={{
            left: pointX,
            top: pointY,
            transition: 'left 220ms cubic-bezier(0.22, 1, 0.36, 1), top 220ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <svg
            key={`pointer-${activitySerial}`}
            width={32}
            height={32}
            viewBox="0 0 32 32"
            style={{
              marginLeft: -4,
              marginTop: -4,
              overflow: 'visible',
              filter: 'drop-shadow(0 1.5px 2px rgba(12,54,110,0.24))',
              animation: pointerAnimation,
              transformOrigin: '4px 4px',
            }}
          >
            <defs>
              <path
                id={`${pointerGradientId}-shape`}
                d="M4 9 C2.6 5 5 2.6 9 4 L25 10 C29 11.5 29 15.2 25.2 17 L20.8 19 C20 19.4 19.4 20 19 20.8 L17 25.2 C15.2 29 11.5 29 10 25 Z"
              />
              <linearGradient id={pointerGradientId} x1="0" y1="0" x2="0.65" y2="1">
                <stop offset="0%" stopColor="#ffffff" />
                <stop offset="55%" stopColor="#f5fbff" />
                <stop offset="100%" stopColor="#e9eaff" />
              </linearGradient>
            </defs>
            <use href={`#${pointerGradientId}-shape`} fill="#1265d8" transform="translate(0.5 1.2) rotate(-12 16 16)" />
            <use href={`#${pointerGradientId}-shape`} fill="#258dff" transform="translate(0.3 0.8) rotate(-7 16 16)" />
            <use href={`#${pointerGradientId}-shape`} fill="#72c6ff" transform="translate(0.15 0.4) rotate(-3 16 16)" />
            <use href={`#${pointerGradientId}-shape`} fill={`url(#${pointerGradientId})`} stroke="#c9e8ff" strokeWidth={0.35} />
          </svg>
        </div>
      )}

      <style>{`
        @keyframes cate-agent-ripple {
          from { transform: scale(1); opacity: 0.9; }
          to { transform: scale(3.4); opacity: 0; }
        }
        @keyframes cate-agent-pointer-click {
          0%, 100% { transform: scale(1); }
          45% { transform: translate(1px, 1px) scale(0.78); }
        }
        @keyframes cate-agent-pointer-type {
          0%, 100% { transform: rotate(0deg); }
          35% { transform: rotate(-7deg); }
          70% { transform: rotate(4deg); }
        }
        @keyframes cate-agent-pointer-scroll {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(8px); }
        }
        @keyframes cate-agent-pointer-hover {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
      `}</style>
    </div>
  )
}
