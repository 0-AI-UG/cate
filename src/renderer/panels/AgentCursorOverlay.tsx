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

const POINTER_LAYERS = [
  { name: 'deep', fill: '#1265d8', offset: 'translate(0.5 1.2) rotate(-12 16 16)', lag: 45 },
  { name: 'middle', fill: '#258dff', offset: 'translate(0.3 0.8) rotate(-7 16 16)', lag: 30 },
  { name: 'near', fill: '#72c6ff', offset: 'translate(0.15 0.4) rotate(-3 16 16)', lag: 15 },
  { name: 'front', fill: '', offset: '', lag: 0 },
] as const

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
    ? 'cate-agent-pointer-click 580ms cubic-bezier(0.22, 1, 0.36, 1)'
    : event.kind === 'type' || event.kind === 'press'
      ? 'cate-agent-pointer-type 520ms ease-out'
      : event.kind === 'scroll'
        ? 'cate-agent-pointer-scroll 520ms ease-in-out'
        : event.kind === 'hover'
          ? 'cate-agent-pointer-hover 700ms ease-in-out'
          : event.kind === 'move' || event.kind === 'drag'
            ? 'cate-agent-pointer-move 700ms ease-in-out'
            : undefined

  return (
    <div
      data-agent-cursor-overlay
      className="absolute inset-0 z-30 overflow-hidden pointer-events-none"
      style={{ containerType: 'size', opacity: visible ? 1 : 0, transition: 'opacity 400ms ease-out' }}
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
      {hasPoint && POINTER_LAYERS.map((layer) => (
        <div
          key={layer.name}
          data-agent-cursor={layer.name === 'front' ? '' : undefined}
          data-agent-cursor-layer={layer.name}
          className="absolute"
          style={{
            left: pointX,
            top: pointY,
            width: 'clamp(18px, min(3cqw, 4cqh), 25.6px)',
            aspectRatio: '1',
            transform: 'translate(-12.5%, -12.5%)',
            transition: `left ${90 + layer.lag}ms cubic-bezier(0.22, 1, 0.36, 1), top ${90 + layer.lag}ms cubic-bezier(0.22, 1, 0.36, 1)`,
          }}
        >
          <div
            data-agent-cursor-idle
            style={{
              width: '100%', height: '100%', transformOrigin: '12.5% 12.5%',
              animation: `cate-agent-pointer-idle 6s ease-in-out ${-6000 + layer.lag * 4}ms infinite`,
            }}
          >
            <svg
              key={`pointer-${activitySerial}`}
              width="100%"
              height="100%"
              viewBox="0 0 32 32"
              style={{
                display: 'block',
                overflow: 'visible',
                filter: layer.name === 'deep' ? 'drop-shadow(0 1.5px 2px rgba(12,54,110,0.24))' : undefined,
                animation: pointerAnimation,
                animationDelay: `${layer.lag}ms`,
                transformOrigin: '12.5% 12.5%',
              }}
            >
              <defs>
                <linearGradient id={`${pointerGradientId}-${layer.name}`} x1="0" y1="0" x2="0.65" y2="1">
                  <stop offset="0%" stopColor="#ffffff" />
                  <stop offset="55%" stopColor="#f5fbff" />
                  <stop offset="100%" stopColor="#e9eaff" />
                </linearGradient>
              </defs>
              <g transform={layer.offset}>
                <path
                  d="M4 9 C2.6 5 5 2.6 9 4 L25 10 C29 11.5 29 15.2 25.2 17 L20.8 19 C20 19.4 19.4 20 19 20.8 L17 25.2 C15.2 29 11.5 29 10 25 Z"
                  fill={layer.fill || `url(#${pointerGradientId}-${layer.name})`}
                  stroke={layer.name === 'front' ? '#c9e8ff' : undefined}
                  strokeWidth={0.35}
                />
              </g>
            </svg>
          </div>
        </div>
      ))}

      <style>{`
        @keyframes cate-agent-ripple {
          from { transform: scale(1); opacity: 0.9; }
          to { transform: scale(3.4); opacity: 0; }
        }
        @keyframes cate-agent-pointer-click {
          0%, 100% { transform: scale(1); }
          24% { transform: translate(0.8px, 0.8px) scale(0.84); }
          58% { transform: scale(1.07); }
        }
        @keyframes cate-agent-pointer-idle {
          0%, 100% { transform: rotate(-7deg) scale(0.985); }
          50% { transform: rotate(7deg) scale(1.025); }
        }
        @keyframes cate-agent-pointer-move {
          0%, 100% { transform: rotate(0deg); }
          35% { transform: rotate(-5deg) scale(1.04, 0.98); }
          70% { transform: rotate(2deg); }
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
        @media (prefers-reduced-motion: reduce) {
          [data-agent-cursor-layer], [data-agent-cursor-overlay] { transition: none !important; }
          [data-agent-cursor-idle], [data-agent-cursor-layer] svg { animation: none !important; }
          [data-agent-effect="click"] { animation: none !important; opacity: 0; }
        }
      `}</style>
    </div>
  )
}
