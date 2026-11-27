// A context menu drawn in the app (not the native one): a column of items at
// a window point, where an item may open a submenu to its side. Submenus open
// on a short rest or with ArrowRight / Enter, close with ArrowLeft; Escape, a
// press outside, a resize or the window losing focus close the whole menu.
// Every column stays inside the window: the root opens up and to the left of
// the point when there is no room below or to the right, and a submenu opens
// on the parent's left side when there is no room on its right. Labels are
// shown in the interface language.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import { POPOVER_SURFACE } from './Popover'
import { HOVER_OPEN_MS } from './HoverIntent'
import { useT } from '../../settings'

export type CascadingMenuItem =
  | { type: 'separator' }
  | {
    type?: 'item'
    id: string
    label: string
    icon?: ReactNode
    disabled?: boolean
    /** Runs after the menu closed. Ignored when the item has a submenu. */
    onSelect?: () => void
    submenu?: readonly CascadingMenuItem[]
  }

type Entry = Exclude<CascadingMenuItem, { type: 'separator' }>

/** Space kept between a menu and the window's edge. */
export const MENU_EDGE_MARGIN = 8
/** Overlap of a submenu over its parent column. */
const SUBMENU_GAP = 4

const isEntry = (item: CascadingMenuItem): item is Entry => item.type !== 'separator'

/** Where a column of `size` goes: the root at `point` (flipping to the other
 *  side of it when it would leave the window), a submenu beside `anchor`
 *  (the item that opened it). Always inside the window. */
export function menuPosition(
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  at: { point: { x: number; y: number } } | { anchor: { left: number; right: number; top: number } },
): { left: number; top: number } {
  const m = MENU_EDGE_MARGIN
  const maxLeft = Math.max(m, viewport.width - m - size.width)
  const maxTop = Math.max(m, viewport.height - m - size.height)
  let left: number
  let top: number
  if ('point' in at) {
    left = at.point.x + size.width <= viewport.width - m ? at.point.x : at.point.x - size.width
    top = at.point.y + size.height <= viewport.height - m ? at.point.y : at.point.y - size.height
  } else {
    const right = at.anchor.right - SUBMENU_GAP
    left = right + size.width <= viewport.width - m ? right : at.anchor.left + SUBMENU_GAP - size.width
    // The submenu's first item lines up with the item that opened it.
    top = at.anchor.top - 6
  }
  return { left: Math.min(Math.max(left, m), maxLeft), top: Math.min(Math.max(top, m), maxTop) }
}

export function CascadingMenu({ x, y, items, onClose, ariaLabel }: {
  /** The window point it opens at (the pointer). */
  x: number
  y: number
  items: readonly CascadingMenuItem[]
  onClose: () => void
  ariaLabel?: string
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const close = () => closeRef.current()
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [])

  const select = useCallback((entry: Entry) => {
    closeRef.current()
    entry.onSelect?.()
  }, [])

  return createPortal(
    <div ref={rootRef} data-cascading-menu onContextMenu={(event) => event.preventDefault()} onMouseDown={(event) => event.stopPropagation()}>
      <MenuColumn items={items} at={{ point: { x, y } }} depth={0} ariaLabel={ariaLabel} onSelect={select} autoFocus />
    </div>,
    document.body,
  )
}

function MenuColumn({ items, at, depth, ariaLabel, onSelect, onBack, autoFocus }: {
  items: readonly CascadingMenuItem[]
  at: { point: { x: number; y: number } } | { anchor: { left: number; right: number; top: number } }
  depth: number
  ariaLabel?: string
  onSelect: (entry: Entry) => void
  /** ArrowLeft in a submenu: back to its parent. */
  onBack?: () => void
  autoFocus?: boolean
}): JSX.Element {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<{ left: number; right: number; top: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const atKey = JSON.stringify(at)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPosition(menuPosition({ width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, at))
    // Re-measure when the items change (a submenu's entries arriving).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atKey, items.length])

  useEffect(() => {
    if (autoFocus && position) ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [autoFocus, position])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const open = (entry: Entry | null, button: HTMLElement | null, focusChild = false) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (!entry?.submenu || !button) { setOpenId(null); return }
    const rect = button.getBoundingClientRect()
    setAnchor({ left: rect.left, right: rect.right, top: rect.top })
    setOpenId(entry.id)
    if (focusChild) requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-menu-depth="${depth + 1}"] button:not(:disabled)`)?.focus()
    })
  }

  const openSoon = (entry: Entry, button: HTMLElement) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => open(entry, button), entry.submenu ? HOVER_OPEN_MS : 0)
  }

  const buttons = (): HTMLButtonElement[] => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(':scope > div > button:not(:disabled)') ?? [])

  const onKeyDown = (event: React.KeyboardEvent) => {
    const list = buttons()
    const index = list.indexOf(document.activeElement as HTMLButtonElement)
    const entry = index >= 0 ? items.filter(isEntry).filter((e) => !e.disabled)[index] : undefined
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      event.stopPropagation()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length
      list[next]?.focus()
    } else if (event.key === 'ArrowRight' && entry?.submenu) {
      event.preventDefault()
      event.stopPropagation()
      open(entry, list[index], true)
    } else if (event.key === 'ArrowLeft' && onBack) {
      event.preventDefault()
      event.stopPropagation()
      onBack()
    }
  }

  const openEntry = openId ? items.filter(isEntry).find((entry) => entry.id === openId) : undefined

  return (
    <>
      <div
        ref={ref}
        role="menu"
        aria-label={ariaLabel && t(ariaLabel)}
        data-menu-depth={depth}
        onKeyDown={onKeyDown}
        className="pointer-events-auto fixed z-[1000] min-w-[200px] max-w-[320px] text-[13px]"
        style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }}
      >
        <div className={`${POPOVER_SURFACE} overflow-y-auto p-1.5`} style={{ maxHeight: `calc(100vh - ${MENU_EDGE_MARGIN * 2}px)` }}>
          {items.map((item, index) => {
            if (!isEntry(item)) return <div key={`separator-${index}`} role="separator" className="mx-1 my-1 border-t border-subtle" />
            const expanded = openId === item.id
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                data-menu-item={item.id}
                disabled={item.disabled}
                aria-haspopup={item.submenu ? 'menu' : undefined}
                aria-expanded={item.submenu ? expanded : undefined}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-primary outline-none transition-colors duration-100 motion-reduce:transition-none hover:bg-hover focus-visible:bg-hover disabled:opacity-40 disabled:hover:bg-transparent ${expanded ? 'bg-hover' : ''}`}
                onMouseEnter={(event) => openSoon(item, event.currentTarget)}
                onMouseLeave={() => { if (timer.current) clearTimeout(timer.current) }}
                onClick={(event) => {
                  if (item.submenu) open(item, event.currentTarget, event.detail === 0)
                  else onSelect(item)
                }}
              >
                {item.icon !== undefined && <span className="flex h-4 w-4 shrink-0 items-center justify-center text-secondary">{item.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{t(item.label)}</span>
                {item.submenu && <ChevronRight size={14} className="shrink-0 text-muted" />}
              </button>
            )
          })}
        </div>
      </div>
      {openEntry?.submenu && anchor && (
        <MenuColumn
          key={openEntry.id}
          items={openEntry.submenu}
          at={{ anchor }}
          depth={depth + 1}
          ariaLabel={openEntry.label}
          onSelect={onSelect}
          onBack={() => {
            setOpenId(null)
            Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[data-menu-item]') ?? []).find((b) => b.dataset.menuItem === openEntry.id)?.focus()
          }}
        />
      )}
    </>
  )
}
