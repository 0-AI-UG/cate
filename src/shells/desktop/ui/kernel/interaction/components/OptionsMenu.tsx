import { useId, useRef, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { PopoverSurface, useDismissableLayer, useViewportPopoverPosition } from './Popover'
import { useDialogLayer } from './dialogLayers'
import { useMenuNumbers } from './menuNumbers'

export type OptionsMenuItem =
  | { type: 'separator' }
  | { id: string; label: string; checked?: boolean; enabled?: boolean }

export const MENU_ROW = 'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] text-primary disabled:opacity-40'
export const MENU_ROW_HIGHLIGHT = 'bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)]'

/** A button that opens a small in-app menu of actions and checkbox options.
 *  `onPick` gets the id of the chosen item; the caller applies it. */
export function OptionsMenu({ items, onPick, label, className, openClassName = '', children, width = 208 }: {
  items: readonly OptionsMenuItem[]
  onPick: (id: string) => void
  label: string
  className: string
  /** Added to the trigger while the menu is open. */
  openClassName?: string
  children: ReactNode
  width?: number
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const id = useId()
  const { pos, portalTarget } = useViewportPopoverPosition(trigger, open,
    (rect, scale) => ({ left: Math.max(8, Math.min(rect.right - width * scale, window.innerWidth - width * scale - 8)), gap: 4, height: items.length * 28 + 8 }), popover)
  useMenuNumbers(popover, open)
  useDismissableLayer({ open, contentRef: popover, triggerRefs: [trigger], onDismiss: () => setOpen(false), closeOnEscape: false })
  useDialogLayer((event) => { event.preventDefault(); event.stopImmediatePropagation(); setOpen(false); trigger.current?.focus() }, open)
  const usable = items.map((item, index) => ('id' in item && item.enabled !== false) ? index : -1).filter((index) => index >= 0)
  const choose = (itemId: string) => { setOpen(false); trigger.current?.focus(); onPick(itemId) }
  const step = (delta: number) => {
    if (!usable.length) return
    const at = usable.indexOf(active)
    setActive(usable[(at + delta + usable.length) % usable.length])
  }
  return <>
    <button ref={trigger} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      className={`${className} ${open ? openClassName : ''}`}
      onClick={() => { setActive(-1); setOpen((value) => !value) }}>
      {children}
    </button>
    {open && <PopoverSurface popoverRef={popover} pos={pos} portalTarget={portalTarget} ownerId={`${id}-trigger`} width={width} className="p-1">
      <div id={id} role="menu" aria-label={label} tabIndex={-1} autoFocus ref={(node) => node?.focus({ preventScroll: true })} className="outline-none"
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); step(1) }
          else if (event.key === 'ArrowUp') { event.preventDefault(); step(-1) }
          else if (event.key === 'Enter' && active >= 0) {
            event.preventDefault()
            const item = items[active]
            if ('id' in item) choose(item.id)
          } else if (event.key === 'Tab') setOpen(false)
        }}>
        {items.map((item, index) => 'id' in item
          ? <button key={item.id} type="button" data-menu-item role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked}
              disabled={item.enabled === false} tabIndex={-1}
              onMouseEnter={() => item.enabled !== false && setActive(index)} onClick={() => choose(item.id)}
              className={`${MENU_ROW} ${index === active ? MENU_ROW_HIGHLIGHT : ''}`}>
              <span className="flex-1 min-w-0 truncate">{item.label}</span>
              {item.checked && <Check size={13} className="shrink-0 text-secondary" />}
            </button>
          : <div key={`sep-${index}`} role="separator" className="mx-2 my-1 border-t border-white/[0.07]" />)}
      </div>
    </PopoverSurface>}
  </>
}
