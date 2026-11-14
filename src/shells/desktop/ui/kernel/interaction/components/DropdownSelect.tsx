import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronLeft, Search } from 'lucide-react'
import { PopoverSurface, useDismissableLayer, useViewportPopoverPosition } from './Popover'
import { useDialogLayer } from './dialogLayers'

export interface DropdownSelectOption { value: string; label: string }

export function DropdownSelect({ options: allOptions, value, onChange, label, labelledBy, searchable = false,
  searchPlaceholder = 'Search…', emptyLabel = 'No matches.', icon, disabled = false, title, side = false, matchTriggerWidth = false, quiet = false,
  className = 'inline-flex h-8 min-w-0 max-w-full items-center gap-2 rounded-md border border-subtle bg-surface-2 px-2 text-xs text-primary',
}: {
  options: readonly DropdownSelectOption[]
  value: string
  onChange: (value: string) => void
  label?: string
  labelledBy?: string
  searchable?: boolean
  searchPlaceholder?: string
  emptyLabel?: string
  icon?: ReactNode
  disabled?: boolean
  title?: string
  side?: boolean
  matchTriggerWidth?: boolean
  quiet?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const listId = useId()
  const options = allOptions.filter((option) => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const current = allOptions.find((option) => option.value === value)?.label ?? value
  const contentWidth = searchable ? 248 : Math.min(300, Math.max(144, ...allOptions.map((option) => option.label.length * 7 + 48)))
  const menuWidth = matchTriggerWidth ? Math.min(trigger.current?.getBoundingClientRect().width || contentWidth, window.innerWidth - 16) : contentWidth
  const { pos, portalTarget } = useViewportPopoverPosition(trigger, open,
    (rect) => {
      const parentLeft = trigger.current?.closest('[data-menu-surface]')?.getBoundingClientRect().left ?? rect.left
      return { left: side && parentLeft > menuWidth + 16 ? parentLeft - menuWidth - 2 : Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)), gap: 4, height: 220 }
    }, popover)
  const menuPos = pos && side && trigger.current ? { ...pos, top: Math.min(trigger.current.getBoundingClientRect().top, window.innerHeight - Math.min(244, allOptions.length * 28 + 12) - 8), placement: 'below' as const } : pos
  useEffect(() => {
    if (!open || !pos) return
    if (!searchable) popover.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus()
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, pos, active, searchable, listId])
  useDismissableLayer({ open, contentRef: popover, triggerRefs: [trigger], onDismiss: () => setOpen(false), closeOnEscape: false })
  useDialogLayer((event) => { event.preventDefault(); event.stopImmediatePropagation(); setOpen(false); trigger.current?.focus() }, open)
  const show = () => { setQuery(''); setActive(Math.max(0, allOptions.findIndex((option) => option.value === value))); setOpen(true) }
  const choose = (id: string) => { onChange(id); setOpen(false); trigger.current?.focus() }

  return <>
    <button ref={trigger} id={`${listId}-trigger`} type="button" aria-label={label} aria-labelledby={labelledBy} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} disabled={disabled} title={title}
      className={`${className} ${open && !quiet ? 'bg-hover text-primary ring-1 ring-inset ring-[var(--border-strong)]' : ''} cursor-pointer disabled:opacity-40 disabled:cursor-default`}
      onClick={() => open ? setOpen(false) : show()}
      onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); show() } }}>
      {icon}<span className="min-w-0 flex-1 truncate">{current}</span>{side ? <ChevronLeft size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
    </button>
    {open && <PopoverSurface popoverRef={popover} pos={menuPos} portalTarget={portalTarget} ownerId={`${listId}-trigger`} width={menuWidth} className="p-1.5">
      <div onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setActive((index) => options.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length : 0)
        }
        if (event.key === 'Enter' && options[active]) { event.preventDefault(); choose(options[active].value) }
        if (event.key === 'Tab') setOpen(false)
      }}>
        {searchable && <div className="flex items-center gap-2 px-2 pb-1.5 pt-1 text-muted">
          <Search size={13} />
          <input autoFocus role="combobox" aria-label={searchPlaceholder} aria-expanded="true" aria-controls={listId}
            aria-activedescendant={options[active] ? `${listId}-${active}` : undefined}
            value={query} placeholder={searchPlaceholder} onChange={(event) => { setQuery(event.target.value); setActive(0) }}
            className="w-full min-w-0 bg-transparent text-xs text-primary outline-none placeholder:text-muted" />
        </div>}
        <div tabIndex={searchable ? -1 : 0} id={listId} role="listbox" aria-activedescendant={!searchable && options[active] ? `${listId}-${active}` : undefined} aria-label={label} aria-labelledby={labelledBy} className="max-h-60 overflow-y-auto">
          {options.map((entry, index) => <button key={entry.value} id={`${listId}-${index}`} type="button" role="option" aria-selected={value === entry.value}
            tabIndex={-1} onMouseEnter={() => setActive(index)} onClick={() => choose(entry.value)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-left ${index === active ? 'bg-hover text-primary' : 'text-primary'}`}>
            {icon}<span className="flex-1 min-w-0 truncate">{entry.label}</span>
            {value === entry.value && <Check size={13} className="shrink-0" />}
          </button>)}
          {options.length === 0 && <p className="px-2 py-3 text-xs text-muted">{emptyLabel}</p>}
        </div>
      </div>
    </PopoverSurface>}
  </>
}
