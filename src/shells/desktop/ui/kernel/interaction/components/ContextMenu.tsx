// The context menu: drawn in the app with the same surface and rows as every
// other menu, at the pointer. `showContextMenu(items)` resolves with the
// picked id, or null when dismissed. `ContextMenuHost` is mounted once per
// window and draws whichever menu is open.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, Check } from 'lucide-react'
import type { ContextMenuItem } from '@kernel/interaction/contract'
import { MENU_ROW, MENU_ROW_HIGHLIGHT } from './OptionsMenu'
import { POPOVER_SURFACE } from './Popover'
import { useDialogLayer } from './dialogLayers'
import { useMenuNumbers } from './menuNumbers'

interface Open {
  id: number
  items: ContextMenuItem[]
  x: number
  y: number
  trigger: HTMLElement | null
  onHighlight?(id: string | null): void
  resolve(id: string | null): void
}

let current: Open | null = null
let nextId = 0
let pointer = { x: 24, y: 24 }
const listeners = new Set<() => void>()
const notify = () => { for (const l of [...listeners]) l() }

/** Opens a context menu at the pointer. Opening another dismisses this one. */
export function showContextMenu(items: ContextMenuItem[], options?: { onHighlight?(id: string | null): void }): Promise<string | null> {
  const focused = document.activeElement
  const trigger = focused instanceof HTMLElement && !focused.closest('[data-context-menu]') ? focused : current?.trigger ?? null
  current?.resolve(null)
  return new Promise((resolve) => {
    const entry: Open = {
      id: nextId++, items, x: pointer.x, y: pointer.y, trigger, onHighlight: options?.onHighlight,
      resolve(id) {
        if (current !== entry) return
        current = null
        options?.onHighlight?.(null)
        notify()
        resolve(id)
      },
    }
    current = entry
    notify()
  })
}

const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

/** `Cmd+Shift+V` as the keys draw it. */
export function acceleratorLabel(accelerator: string): string {
  const parts = accelerator.split('+')
  if (!MAC) return parts.join('+')
  const symbol: Record<string, string> = { cmd: '⌘', command: '⌘', cmdorctrl: '⌘', ctrl: '⌃', control: '⌃', alt: '⌥', option: '⌥', shift: '⇧', backspace: '⌫', delete: '⌦', enter: '↩' }
  return parts.map((part) => symbol[part.toLowerCase()] ?? part).join('')
}

const usable = (item: ContextMenuItem): boolean => item.type !== 'separator' && item.enabled !== false

function MenuList({ items, x, y, onPick, onBack, onHighlight, layer, parentRect, focusOnOpen }: {
  items: ContextMenuItem[]
  onHighlight?(id: string | null): void
  x: number
  y: number
  onPick(id: string): void
  onBack?(): void
  layer: number
  /** The row a submenu opens from. */
  parentRect?: DOMRect
  focusOnOpen?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [active, setActive] = useState(-1)
  const [sub, setSub] = useState<{ index: number; rect: DOMRect; focus: boolean } | null>(null)

  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    const margin = 8
    let left = parentRect ? parentRect.right - 4 : x
    let top = parentRect ? parentRect.top - 6 : y
    if (left + box.width > innerWidth - margin) left = parentRect ? parentRect.left - box.width + 4 : innerWidth - box.width - margin
    if (top + box.height > innerHeight - margin) top = Math.max(margin, innerHeight - box.height - margin)
    setPos({ left: Math.max(margin, left), top: Math.max(margin, top) })
  }, [x, y, parentRect])

  useEffect(() => {
    if (!parentRect) ref.current?.focus({ preventScroll: true })
    else if (focusOnOpen) {
      const menu = ref.current
      const target = menu?.querySelector<HTMLElement>('[data-menu-item]:not(:disabled)') ?? menu
      target?.focus({ preventScroll: true })
    }
  }, [focusOnOpen, parentRect])
  useEffect(() => { onHighlight?.(items[active]?.id ?? null) }, [active]) // eslint-disable-line react-hooks/exhaustive-deps
  useMenuNumbers(ref, !parentRect)

  const indexes = items.map((item, index) => (usable(item) ? index : -1)).filter((index) => index >= 0)
  const rowAt = (index: number) => ref.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)
  const step = (delta: number) => {
    if (!indexes.length) return
    const at = indexes.indexOf(active)
    const next = at === -1 && delta < 0 ? indexes.length - 1 : (at + delta + indexes.length) % indexes.length
    setSub(null)
    rowAt(indexes[next])?.focus({ preventScroll: true })
  }
  const choose = (index: number) => {
    const item = items[index]
    if (!item || !usable(item)) return
    if (item.submenu?.length) {
      const row = rowAt(index)
      if (row) setSub({ index, rect: row.getBoundingClientRect(), focus: true })
    } else if (item.id) onPick(item.id)
  }

  return (
    <>
      <div
        ref={ref}
        role="menu"
        tabIndex={-1}
        data-context-menu
        className={`fixed min-w-[200px] max-w-[320px] p-1 outline-none ${POPOVER_SURFACE}`}
        style={{ left: pos?.left ?? x, top: pos?.top ?? y, zIndex: layer, visibility: pos ? 'visible' : 'hidden' }}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); step(1) }
          else if (event.key === 'ArrowUp') { event.preventDefault(); step(-1) }
          else if (event.key === 'ArrowRight' && items[active]?.submenu?.length) {
            event.preventDefault()
            choose(active)
          } else if (event.key === 'ArrowLeft' && onBack) { event.preventDefault(); event.stopPropagation(); onBack() }
          else if ((event.key === 'Enter' || event.key === ' ') && active >= 0) {
            event.preventDefault()
            choose(active)
          }
        }}
      >
        {items.map((item, index) => item.type === 'separator'
          ? <div key={`sep-${index}`} role="separator" className="mx-2 my-1 border-t border-white/[0.07]" />
          : (
            <button
              key={item.id ?? `${item.label}-${index}`}
              type="button"
              data-index={index}
              data-menu-item
              role={item.type === 'checkbox' ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={item.type === 'checkbox' ? item.checked === true : undefined}
              aria-haspopup={item.submenu?.length ? 'menu' : undefined}
              aria-expanded={item.submenu?.length ? sub?.index === index : undefined}
              disabled={item.enabled === false}
              tabIndex={-1}
              onFocus={() => setActive(index)}
              onMouseEnter={(event) => {
                if (item.enabled === false) return
                event.currentTarget.focus({ preventScroll: true })
                if (item.submenu?.length) {
                  const rect = event.currentTarget.getBoundingClientRect()
                  setSub((open) => open?.index === index ? open : { index, rect, focus: false })
                }
                else setSub(null)
              }}
              onClick={() => choose(index)}
              className={`${MENU_ROW} ${index === active ? MENU_ROW_HIGHLIGHT : ''}`}
            >
              <span className="flex-1 min-w-0 truncate">{item.label}</span>
              {item.type === 'checkbox' && item.checked && <Check size={13} className="shrink-0 text-secondary" />}
              {item.accelerator && <span className="ml-3 shrink-0 text-[12px] text-muted">{acceleratorLabel(item.accelerator)}</span>}
              {item.submenu?.length ? <ChevronRight size={13} className="shrink-0 text-muted" /> : null}
            </button>
          ))}
      </div>
      {sub && items[sub.index]?.submenu && (
        <MenuList key={sub.index} items={items[sub.index].submenu!} x={0} y={0} parentRect={sub.rect}
          layer={layer} focusOnOpen={sub.focus} onPick={onPick} onBack={() => {
            rowAt(sub.index)?.focus({ preventScroll: true })
            setSub(null)
          }} />
      )}
    </>
  )
}

export function ContextMenuHost(): JSX.Element | null {
  const [, force] = useState(0)
  useEffect(() => {
    const update = () => force((n) => n + 1)
    listeners.add(update)
    return () => { listeners.delete(update) }
  }, [])
  useEffect(() => {
    // Where the menu opens: the last place the pointer pressed.
    const track = (event: MouseEvent) => { pointer = { x: event.clientX, y: event.clientY } }
    document.addEventListener('contextmenu', track, true)
    document.addEventListener('mousedown', track, true)
    return () => {
      document.removeEventListener('contextmenu', track, true)
      document.removeEventListener('mousedown', track, true)
    }
  }, [])
  return current ? <ActiveContextMenu key={current.id} open={current} /> : null
}

function ActiveContextMenu({ open }: { open: Open }): JSX.Element {
  const layer = useDialogLayer((event) => {
    event.preventDefault()
    event.stopImmediatePropagation()
    open.resolve(null)
  })
  useEffect(() => {
    const dismiss = () => open.resolve(null)
    const onDown = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest?.('[data-context-menu]')) return
      dismiss()
    }
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
      if (open.trigger?.isConnected && document.activeElement === document.body) {
        open.trigger.focus({ preventScroll: true })
      }
    }
  }, [open])
  return <MenuList items={open.items} x={open.x} y={open.y} layer={layer} onHighlight={open.onHighlight} onPick={open.resolve} />
}
