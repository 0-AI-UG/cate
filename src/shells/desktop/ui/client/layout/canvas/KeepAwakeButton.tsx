// Keeps the runtime's machine awake for a while or until turned off, over
// the runtime `power` capability. The label counts down the request's time.

import { useEffect, useRef, useState } from 'react'
import { Coffee, Infinity as InfinityIcon } from 'lucide-react'
import { mirrorChannel } from '@kernel/rpc/client'
import { useRuntime } from '../../../kernel/rpc'
import { PopoverSurface, useDismissableLayer, useViewportPopoverPosition } from '../../../kernel/interaction'
import type { KeepAwakeDuration, PowerState } from '@runtime/power/contract/capability'
import { CanvasToolbarButton } from './CanvasToolbarButton'

const WIDTH = 210
const durations = [
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '5h', minutes: 300 },
] as const

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
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const iconRef = useRef<HTMLSpanElement>(null)
  const { pos, portalTarget } = useViewportPopoverPosition(buttonRef, open, (rect) => ({
    left: Math.max(8, Math.min(rect.left + rect.width / 2 - WIDTH / 2, window.innerWidth - WIDTH - 8)),
    gap: 10,
    height: 62,
  }), popoverRef)
  const abovePos = pos && buttonRef.current
    ? { left: pos.left, top: buttonRef.current.getBoundingClientRect().top - 10, placement: 'above' as const }
    : null
  useDismissableLayer({ open, contentRef: popoverRef, triggerRefs: [buttonRef], onDismiss: () => setOpen(false) })

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
      setOpen(false)
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }

  const on = state.requested
  return (
    <>
      <CanvasToolbarButton
        ref={buttonRef}
        action="toggleKeepAwake"
        label={error ? 'Keep awake failed, retry' : on ? state.endsAt === null ? 'Keep awake: unlimited' : `Keep awake: ${remainingLabel(state.endsAt, now)} remaining` : 'Keep awake: off'}
        active={on || open}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={pending}
        onClick={() => setOpen(value => !value)}
        tooltipPlacement={tooltipPlacement}
        className="relative"
      >
        <span ref={iconRef} className="flex" aria-hidden="true">
          <Coffee size={18} fill={on ? 'currentColor' : 'none'} />
        </span>
        {on && <span className="absolute -top-1 -left-2 rounded-md border border-subtle bg-surface-3 px-1 text-[9px] font-semibold leading-4 text-primary whitespace-nowrap pointer-events-none" aria-hidden="true">{remainingLabel(state.endsAt, now)}</span>}
      </CanvasToolbarButton>
      {open && <PopoverSurface popoverRef={popoverRef} pos={abovePos} portalTarget={portalTarget} width={WIDTH} className="p-2">
        <div className="flex items-center gap-1" role="menu" aria-label="Keep awake duration">
          {durations.map(({ label, minutes }) => <button key={minutes} type="button" role="menuitem" disabled={pending} onClick={() => void select(minutes)} className="flex-1 rounded-lg px-1.5 py-1.5 text-xs text-primary hover:bg-hover-strong" aria-label={`Keep awake for ${label}`}>{label}</button>)}
          <button type="button" role="menuitem" disabled={pending} onClick={() => void select(null)} className="flex-1 flex justify-center rounded-lg px-1.5 py-1.5 text-primary hover:bg-hover-strong" aria-label="Keep awake unlimited" title="Unlimited"><InfinityIcon size={16} /></button>
        </div>
        {on && <button type="button" disabled={pending} onClick={() => void select(false)} className="mt-1 w-full rounded-lg py-1 text-[11px] text-secondary hover:bg-hover-strong">Turn off</button>}
        {error && <p className="px-1 text-[11px] text-red-400">Couldn’t change keep awake.</p>}
      </PopoverSurface>}
    </>
  )
}
