// The context menu: drawn in the app with the same surface and rows as every
// other menu, at the pointer. `showContextMenu(items)` resolves with the
// picked id, or null when dismissed. `ContextMenuHost` is mounted once per
// window and draws whichever menu is open.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, Check } from 'lucide-react'
import type { ContextMenuItem } from '@kernel/interaction/contract'
import { MENU_ROW, MENU_ROW_HIGHLIGHT } from './OptionsMenu'
import { POPOVER_SURFACE } from './Popover'
import { popoverLayer } from './dialogLayers'
import { useMenuNumbers } from './menuNumbers'

interface Open { items: ContextMenuItem[]; x: number; y: number; onHighlight?(id: string | null): void; resolve(id: string | null): void }

let current: Open | null = null
let pointer = { x: 24, y: 24 }
const listeners = new Set<() => void>()
const notify = () => { for (const l of [...listeners]) l() }

/** Opens a context menu at the pointer. Opening another dismisses this one. */
export function showContextMenu(items: ContextMenuItem[], options?: { onHighlight?(id: string | null): void }): Promise<string | null> {
  current?.resolve(null)
  return new Promise((resolve) => {
    const entry: Open = { items, x: pointer.x, y: pointer.y, onHighlight: options?.onHighlight, resolve: (id) => { if (current === entry) current = null; options?.onHighlight?.(null); notify(); resolve(id) } }
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

function MenuList({ items, x, y, onPick, onClose, onHighlight, depth, parentRect }: {
  items: ContextMenuItem[]
  onHighlight?(id: string | null): void
  x: number
  y: number
  onPick(id: string): void
  onClose(): void
  depth: number
  /** The row a submenu opens from. */
  parentRect?: DOMRect
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [active, setActive] = useState(-1)
  const [sub, setSub] = useState<{ index: number; rect: DOMRect } | null>(null)

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

  useEffect(() => { if (depth === 0) ref.current?.focus({ preventScroll: true }) }, [depth])
  useEffect(() => { onHighlight?.(items[active]?.id ?? null) }, [active]) // eslint-disable-line react-hooks/exhaustive-deps
  useMenuNumbers(ref, depth === 0)

  const indexes = items.map((item, index) => (usable(item) ? index : -1)).filter((index) => index >= 0)
  const step = (delta: number) => {
    if (!indexes.length) return
    const at = indexes.indexOf(active)
    setActive(indexes[(at + delta + indexes.length) % indexes.length])
  }
  const choose = (index: number, row?: HTMLElement | null) => {
    const item = items[index]
    if (!item || !usable(item)) return
    if (item.submenu?.length) { if (row) setSub({ index, rect: row.getBoundingClientRect() }); return }
    if (item.id) onPick(item.id)
  }

  return (
    <>
      <div
        ref={ref}
        role="menu"
        tabIndex={-1}
        data-context-menu
        className={`fixed min-w-[200px] max-w-[320px] p-1 outline-none ${POPOVER_SURFACE}`}
        style={{ left: pos?.left ?? x, top: pos?.top ?? y, zIndex: popoverLayer() + depth, visibility: pos ? 'visible' : 'hidden' }}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); step(1) }
          else if (event.key === 'ArrowUp') { event.preventDefault(); step(-1) }
          else if (event.key === 'ArrowRight' && items[active]?.submenu?.length) {
            event.preventDefault()
            choose(active, ref.current?.querySelector<HTMLElement>(`[data-index="${active}"]`))
          } else if (event.key === 'ArrowLeft' && depth > 0) { event.preventDefault(); event.stopPropagation(); onClose() }
          else if (event.key === 'Enter' && active >= 0) {
            event.preventDefault()
            choose(active, ref.current?.querySelector<HTMLElement>(`[data-index="${active}"]`))
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
              disabled={item.enabled === false}
              tabIndex={-1}
              onMouseEnter={(event) => {
                if (item.enabled === false) return
                setActive(index)
                if (item.submenu?.length) setSub({ index, rect: event.currentTarget.getBoundingClientRect() })
                else setSub(null)
              }}
              onClick={(event) => choose(index, event.currentTarget)}
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
        <MenuList items={items[sub.index].submenu!} x={0} y={0} parentRect={sub.rect} depth={depth + 1} onPick={onPick} onClose={() => setSub(null)} />
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
  const open = current
  useEffect(() => {
    if (!open) return
    const dismiss = () => open.resolve(null)
    const onDown = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest?.('[data-context-menu]')) return
      dismiss()
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss() } }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [open])
  if (!open) return null
  return <MenuList key={open.x + ':' + open.y + ':' + open.items.length} items={open.items} x={open.x} y={open.y} depth={0} onHighlight={open.onHighlight} onPick={(id) => open.resolve(id)} onClose={() => open.resolve(null)} />
}
