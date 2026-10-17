// Keeps the runtime's machine awake for a while or until turned off, over
// the runtime `power` capability. The label counts down the request's time.
// A click toggles it (unlimited or off); resting on it shows the durations.

import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Coffee, Infinity as InfinityIcon, Power } from 'lucide-react'
import { mirrorChannel } from '@kernel/rpc/client'
import { useRuntime } from '../../../kernel/rpc'
import { Tooltip, useDismissableLayer } from '../../../kernel/interaction'
import type { KeepAwakeDuration, PowerState } from '@runtime/power/contract/capability'
import { CanvasToolbarButton } from './CanvasToolbarButton'

const durations = [
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '5h', minutes: 300 },
] as const

/** Hover intent, as on the new-terminal button's agent flyout. */
const OPEN_MS = 140
const CLOSE_MS = 180

const OFF: PowerState = { requested: false, endsAt: null, busy: false, holding: false }

function remainingLabel(endsAt: number | null, now: number): string {
  if (endsAt === null) return '∞'
  const minutes = Math.max(1, Math.ceil((endsAt - now) / 60_000))
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`
}

export function KeepAwakeButton({ workspaceId, tooltipPlacement = 'top' }: { workspaceId: string; tooltipPlacement?: 'top' | 'right' }) {
  const power = useRuntime(workspaceId)?.power ?? null
  const [state, setState] = useState<PowerState>(OFF)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState(false)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const open = anchor !== null
  const [now, setNow] = useState(Date.now())
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const iconRef = useRef<HTMLSpanElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearHoverTimer = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
  }
  const close = () => {
    clearHoverTimer()
    setAnchor(null)
  }
  const hoverIn = () => {
    clearHoverTimer()
    if (anchor) return
    hoverTimer.current = setTimeout(() => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (rect) setAnchor(rect)
    }, OPEN_MS)
  }
  const hoverOut = () => {
    clearHoverTimer()
    hoverTimer.current = setTimeout(close, CLOSE_MS)
  }
  useEffect(() => clearHoverTimer, [])
  // The same column as the agent spawn flyout: up from a horizontal bar,
  // out to the left of a vertical one.
  const side = tooltipPlacement === 'top' ? 'up' : 'left'
  useDismissableLayer({ open, contentRef: popoverRef, triggerRefs: [buttonRef], onDismiss: close })

  useEffect(() => {
    if (!power) {
      setPending(true)
      return
    }
    // The channel starts with a snapshot, so no separate `get` is needed.
    const mirror = mirrorChannel<PowerState>(() => power.subscribe())
    const stop = mirror.subscribe((channel) => {
      if (!channel) return
      setState(channel.snapshot)
      setNow(Date.now())
      setPending(false)
    })
    return () => { stop(); mirror.dispose() }
  }, [power])

  useEffect(() => {
    if (!state.requested || state.endsAt === null) return
    const interval = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(interval)
  }, [state.requested, state.endsAt])

  const select = async (duration: KeepAwakeDuration) => {
    if (!power) return
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      iconRef.current?.getAnimations().forEach((animation) => animation.cancel())
      iconRef.current?.animate([
        { transform: 'translateY(0)' },
        { transform: 'translateY(-3px)', offset: 0.4 },
        { transform: 'translateY(0)' },
      ], { duration: 320, easing: 'ease-in-out' })
    }
    setPending(true)
    setError(false)
    try {
      setState(await power.set({ duration }))
      setNow(Date.now())
      close()
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }

  const on = state.requested
  return (
    <div className="flex shrink-0" onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
      <CanvasToolbarButton
        ref={buttonRef}
        action="toggleKeepAwake"
        label={error ? 'Keep awake failed, retry' : on ? state.endsAt === null ? 'Keep awake: unlimited' : `Keep awake: ${remainingLabel(state.endsAt, now)} remaining` : 'Keep awake: off'}
        active={on || open}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={pending}
        onClick={() => { close(); void select(on ? false : null) }}
        tooltipPlacement={tooltipPlacement}
        tooltipSuppressed={open}
        className="relative"
      >
        <span ref={iconRef} className="flex" aria-hidden="true">
          <Coffee size={18} fill={on ? 'currentColor' : 'none'} />
        </span>
        {on && <span className="absolute -top-1 -left-2 rounded-md border border-subtle bg-surface-3 px-1 text-[9px] font-semibold leading-4 text-primary whitespace-nowrap pointer-events-none" aria-hidden="true">{remainingLabel(state.endsAt, now)}</span>}
      </CanvasToolbarButton>
      {anchor && createPortal(
        <div
          ref={popoverRef}
          className="fixed z-[90]"
          onMouseEnter={clearHoverTimer}
          onMouseLeave={hoverOut}
          style={side === 'up'
            ? { left: anchor.left + anchor.width / 2, bottom: window.innerHeight - anchor.top, transform: 'translateX(-50%)', paddingBottom: 10 }
            : { right: window.innerWidth - anchor.left, bottom: window.innerHeight - anchor.bottom, paddingRight: 10 }}
        >
          <div
            role="menu"
            aria-label="Keep awake duration"
            className="cate-spawn-flyout flex flex-col-reverse items-center gap-1 p-1 rounded-full border border-subtle bg-surface-0 shadow-[0_8px_24px_-6px_var(--shadow-node)]"
            style={{ transformOrigin: side === 'up' ? 'bottom center' : 'bottom right' }}
          >
            {[
              ...durations.map(({ label, minutes }) => ({ key: label, duration: minutes as KeepAwakeDuration, tip: `Keep awake for ${label}`, content: label as React.ReactNode })),
              { key: 'unlimited', duration: null as KeepAwakeDuration, tip: 'Keep awake unlimited', content: <InfinityIcon size={16} /> as React.ReactNode },
              ...(on ? [{ key: 'off', duration: false as KeepAwakeDuration, tip: 'Turn off', content: <Power size={15} /> as React.ReactNode }] : []),
            ].map((item, index) => (
              <Tooltip key={item.key} label={item.tip} placement={side === 'up' ? 'right' : 'left'}>
                <button
                  type="button"
                  role="menuitem"
                  aria-label={item.tip}
                  disabled={pending}
                  onClick={() => void select(item.duration)}
                  style={{ '--i': index, WebkitTapHighlightColor: 'transparent' } as React.CSSProperties}
                  className="cate-spawn-flyout-item h-9 w-9 shrink-0 flex items-center justify-center rounded-full text-xs font-medium text-primary hover:bg-hover-strong hover:scale-110 active:scale-[0.92] transition-transform duration-100"
                >
                  {item.content}
                </button>
              </Tooltip>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
