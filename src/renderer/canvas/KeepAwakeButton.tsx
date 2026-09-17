import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Coffee } from 'lucide-react'
import { CanvasToolbarButton } from './CanvasToolbarButton'
import { useDismissableLayer } from '../ui/Popover'

export function KeepAwakeButton({ tooltipPlacement, onOpenChange }: {
  tooltipPlacement: 'top' | 'right'
  onOpenChange?: (open: boolean) => void
}) {
  const [enabled, setEnabled] = useState(false)
  const [endsAt, setEndsAt] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const [pending, setPending] = useState(true)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const iconRef = useRef<HTMLSpanElement>(null)
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange

  useEffect(() => { onOpenChangeRef.current?.(open) }, [open])
  useDismissableLayer({ open, contentRef: menuRef, triggerRefs: [buttonRef], onDismiss: () => setOpen(false) })

  useEffect(() => {
    let mounted = true
    let receivedChange = false
    const unsubscribe = window.electronAPI.onKeepAwakeChanged((active, expiry) => {
      receivedChange = true
      setEnabled(active)
      setEndsAt(expiry)
      setNow(Date.now())
    })
    void window.electronAPI.getKeepAwakeStatus().then((status) => {
      if (mounted && !receivedChange) {
        setEnabled(status.enabled)
        setEndsAt(status.endsAt)
      }
    }).catch(() => {
      if (mounted) setError(true)
    }).finally(() => {
      if (mounted) setPending(false)
    })
    return () => { mounted = false; unsubscribe() }
  }, [])

  useEffect(() => {
    if (!enabled || endsAt === null) return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [enabled, endsAt])

  const select = async (active: boolean, minutes?: number) => {
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
      await window.electronAPI.setKeepAwake(active, minutes)
      setOpen(false)
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }

  const remainingMinutes = endsAt === null ? null : Math.max(1, Math.ceil((endsAt - now) / 60_000))
  const rect = open ? buttonRef.current?.getBoundingClientRect() : undefined
  return <>
    <CanvasToolbarButton
      ref={buttonRef}
      action="toggleKeepAwake"
      label={error
        ? 'Keep awake failed — retry'
        : enabled
          ? `Keep awake: ${remainingMinutes === null ? 'until turned off' : `${remainingMinutes} min left`}`
          : 'Keep awake: off'}
      active={enabled}
      aria-haspopup="dialog"
      aria-expanded={open}
      disabled={pending}
      onClick={() => setOpen((value) => !value)}
      tooltipPlacement={tooltipPlacement}
    >
      <span ref={iconRef} className="relative flex" aria-hidden="true">
        <Coffee size={18} fill={enabled ? 'currentColor' : 'none'} />
        {enabled && <span className="absolute -right-2 -top-2 min-w-[14px] rounded-full bg-surface-5 px-0.5 text-center text-[9px] font-semibold leading-[14px] text-primary">
          {remainingMinutes === null ? '∞' : remainingMinutes}
        </span>}
      </span>
    </CanvasToolbarButton>
    {open && rect && createPortal(
      <div ref={menuRef} role="dialog" aria-label="Keep awake duration"
        className="fixed z-[1000] w-[184px] rounded-2xl border border-subtle py-1.5 text-xs shadow-xl"
        style={{ left: Math.max(8, Math.min(rect.left + rect.width / 2 - 92, window.innerWidth - 192)), bottom: window.innerHeight - rect.top + 10, background: 'color-mix(in srgb, var(--surface-0) 80%, transparent)', backdropFilter: 'blur(24px) saturate(1.5)', WebkitBackdropFilter: 'blur(24px) saturate(1.5)' }}
        onMouseDown={(event) => event.stopPropagation()}>
        <div className="px-3 pb-1 pt-0.5 text-[11px] font-medium text-muted">Keep awake for</div>
        {[15, 30, 45, 60].map((minutes) => <button key={minutes} type="button" disabled={pending}
          className="mx-1 flex w-[calc(100%-8px)] rounded-lg px-2 py-1.5 text-left text-primary hover:bg-surface-3 disabled:opacity-50"
          onClick={() => void select(true, minutes)}>{minutes} min</button>)}
        <button type="button" disabled={pending}
          className="mx-1 flex w-[calc(100%-8px)] rounded-lg px-2 py-1.5 text-left text-primary hover:bg-surface-3 disabled:opacity-50"
          onClick={() => void select(true)}>∞ · Until turned off</button>
        {enabled && <>
          <div className="mx-2 my-1 border-t border-subtle" />
          <button type="button" disabled={pending}
            className="mx-1 flex w-[calc(100%-8px)] rounded-lg px-2 py-1.5 text-left text-secondary hover:bg-surface-3 disabled:opacity-50"
            onClick={() => void select(false)}>Turn off</button>
        </>}
        {error && <div className="px-3 py-1 text-[11px] text-red-400">Couldn’t update keep awake.</div>}
      </div>, document.body)}
  </>
}
