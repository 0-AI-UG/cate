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

import { useEffect, useRef, useState } from 'react'
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
  const [rawBoxLeft, rawBoxTop, rawBoxWidth, rawBoxHeight] = event.rect ?? []
  const boxLeft = rawBoxLeft === undefined ? undefined : rawBoxLeft * scale
  const boxTop = rawBoxTop === undefined ? undefined : rawBoxTop * scale
  const boxWidth = rawBoxWidth === undefined ? undefined : rawBoxWidth * scale
  const boxHeight = rawBoxHeight === undefined ? undefined : rawBoxHeight * scale
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
  const targetAnimation = event.kind === 'type' || event.kind === 'press'
    ? 'cate-agent-target-type 650ms ease-out'
    : event.kind === 'hover'
      ? 'cate-agent-target-hover 900ms ease-in-out'
      : event.kind === 'click' || event.kind === 'dblclick'
        ? 'cate-agent-target-click 450ms ease-out'
        : undefined

  return (
    <div
      className="absolute inset-0 z-30 overflow-hidden pointer-events-none"
      style={{ opacity: visible ? 1 : 0, transition: 'opacity 400ms ease-out' }}
      aria-hidden
    >
      {/* Target highlight — the element the action is aimed at. */}
      {event.rect && (
        <div
          key={`target-${activitySerial}`}
          data-agent-effect={event.kind}
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
            animation: targetAnimation,
          }}
        />
      )}

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

      {/* The pointer. Action feedback is visual only: click rings, target
          pulses and pointer motion. Command labels/selectors stay out of the UI. */}
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
          {/* Drawn rather than using an emoji/system cursor so it looks
              identical on every platform and reads as "not your cursor". */}
          <svg
            key={`pointer-${activitySerial}`}
            width="18"
            height="22"
            viewBox="0 0 18 22"
            style={{
              filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.5))',
              animation: pointerAnimation,
              transformOrigin: '2px 1px',
            }}
          >
            <path d="M2 1 L2 17 L6.2 13.2 L9 20 L12 18.6 L9.2 12 L14.5 12 Z" fill="#4A9EFF" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
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
        @keyframes cate-agent-target-click {
          0% { opacity: 1; transform: scale(1); }
          100% { opacity: 0.35; transform: scale(1.025); }
        }
        @keyframes cate-agent-target-type {
          0%, 100% { opacity: 0.7; }
          50% { opacity: 1; box-shadow: 0 0 0 5px rgba(74,158,255,0.24); }
        }
        @keyframes cate-agent-target-hover {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  )
}
