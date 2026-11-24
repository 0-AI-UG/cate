import { useEffect, useId, useRef, useState } from 'react'
import { Clock3 } from 'lucide-react'
import { Button, Modal, PopoverSurface, Tooltip, inputCls, useDismissableLayer, useMenuNumbers, useViewportPopoverPosition } from '../../kernel/interaction'
import { useDialogLayer } from '../../kernel/interaction/components/dialogLayers'

export function snoozeChoices(now: number): { label: string; until: number }[] {
  const evening = new Date(now)
  evening.setHours(18, 0, 0, 0)
  const eveningIsTomorrow = evening.getTime() <= now
  if (eveningIsTomorrow) evening.setDate(evening.getDate() + 1)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  return [
    { label: 'In 1 hour', until: now + 60 * 60 * 1000 },
    { label: eveningIsTomorrow ? 'Tomorrow evening' : 'This evening', until: evening.getTime() },
    { label: 'In 3 hours', until: now + 3 * 60 * 60 * 1000 },
    { label: 'Tomorrow', until: tomorrow.getTime() },
  ].sort((a, b) => a.until - b.until)
}

function localDateTime(time: number): string {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function ThreadSnooze({ title, onSnooze, onOpenChange }: { title: string; onSnooze: (until: number) => void; onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState(false)
  const [date, setDate] = useState('')
  const [openedAt, setOpenedAt] = useState(Date.now())
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const changeOpen = (next: boolean) => { setOpen(next); onOpenChange(next) }
  const close = () => { changeOpen(false); trigger.current?.focus() }
  const { pos, portalTarget } = useViewportPopoverPosition(trigger, open, (rect, scale) => ({
    left: Math.max(8, Math.min(rect.right - 256 * scale, window.innerWidth - 264 * scale)), gap: 4, height: 164,
  }), popover)
  useEffect(() => { if (open && pos) popover.current?.querySelector<HTMLElement>('[role="dialog"]')?.focus() }, [open, pos])
  useDismissableLayer({ open, contentRef: popover, triggerRefs: [trigger], onDismiss: () => changeOpen(false), closeOnEscape: false })
  useDialogLayer((event) => { event.preventDefault(); event.stopImmediatePropagation(); close() }, open)
  useMenuNumbers(popover, open)
  const choose = (until: number) => { changeOpen(false); setCustom(false); onSnooze(until) }
  return <>
    <Tooltip label="Snooze thread" suppressed={open || custom}>
      <button ref={trigger} id={`${id}-trigger`} type="button" aria-label={`Snooze ${title}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        className="flex h-5 w-5 items-center justify-center rounded text-secondary hover:text-primary focus-visible:outline-offset-2"
        onClick={() => { setOpenedAt(Date.now()); changeOpen(!open) }}><Clock3 size={13} /></button>
    </Tooltip>
    {open && <PopoverSurface popoverRef={popover} pos={pos} portalTarget={portalTarget} width={256} className="p-1" ownerId={trigger.current?.id}>
      <div id={id} role="dialog" tabIndex={-1} className="outline-none" aria-label="Snooze thread" onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        const buttons = [...event.currentTarget.querySelectorAll('button')]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }}>
        {snoozeChoices(openedAt).map(({ label, until }) => <button key={label} type="button" data-menu-item onClick={() => choose(until)}
          className="flex h-7 w-full items-center gap-2 whitespace-nowrap rounded-md px-2 text-left text-[13px] text-primary outline-none hover:bg-hover focus:bg-hover focus-visible:outline-none">
          <span className="flex-1">{label}</span><span className="tabular-nums text-[12px] text-muted">{new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </button>)}
        <div className="mx-2 my-1 border-t border-subtle" />
        <button type="button" data-menu-item className="flex h-7 w-full items-center rounded-md px-2 text-left text-[13px] text-primary outline-none hover:bg-hover focus:bg-hover focus-visible:outline-none"
          onClick={() => { setDate(localDateTime(Date.now() + 60 * 60 * 1000)); changeOpen(false); setCustom(true); onOpenChange(true) }}>Custom…</button>
      </div>
    </PopoverSurface>}
    {custom && <Modal title="Snooze thread" width={360} onClose={() => { setCustom(false); onOpenChange(false) }}>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); const until = new Date(date).getTime(); if (until > Date.now()) choose(until) }}>
        <p className="truncate text-sm text-secondary">{title}</p>
        <label className="block space-y-2 text-xs text-primary"><span>Remind me at</span>
          <input autoFocus type="datetime-local" aria-label="Snooze until" className={inputCls} value={date} min={localDateTime(Date.now())} onChange={(event) => setDate(event.target.value)} />
        </label>
        <div className="flex justify-end"><Button type="submit" disabled={!(new Date(date).getTime() > Date.now())}>Snooze</Button></div>
      </form>
    </Modal>}
  </>
}
