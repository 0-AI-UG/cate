// The new-tab button and its menu of panel types (the creatable
// definitions). On a canvas node the menu portals into the canvas's top
// overlay (DockMenuPortalContext) so it pans and zooms with the node.

import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'
import { Icon, POPOVER_SURFACE, Tooltip } from '../../../kernel/interaction'
import { isIconName, type IconName } from '@kernel/interaction/contract'
import { creatableDefinitions } from '@client/host'

/** Where a node dock's menus portal to: the canvas view's top overlay layer
 *  (in canvas space). Null outside a canvas. */
export const DockMenuPortalContext = createContext<HTMLElement | null>(null)

export type NewTabItem = { type: string; label: string; icon: IconName }

/** The types a dock's new-tab menu offers, in creation order. */
export function newTabItems(where: { onCanvas?: boolean } = {}): NewTabItem[] {
  return creatableDefinitions(where).map((definition) => ({
    type: definition.type,
    label: definition.label,
    icon: isIconName(definition.icon) ? definition.icon : 'plus',
  }))
}

export interface DockTabContextMenuProps {
  open: boolean
  position: { top: number; right: number } | null
  items: NewTabItem[]
  onPick: (type: string) => void
  onClose: () => void
  portalTarget?: HTMLElement | null
  anchorRef?: React.RefObject<HTMLButtonElement>
  ariaLabel?: string
  showConnectionPort?: boolean
}

export function DockTabContextMenu({ open, position, items, onPick, onClose, anchorRef, portalTarget, ariaLabel = 'New Tab', showConnectionPort = false }: DockTabContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !anchorRef?.current?.contains(event.target as Node)) onClose()
    }
    const onResize = () => onClose()
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('resize', onResize)
    }
  }, [open, onClose, anchorRef])
  if (!open || !position) return null
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      className="dock-new-tab-menu pointer-events-auto z-[1000] w-[220px] max-w-[calc(100vw-16px)] text-[13px]"
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') { onClose(); event.stopPropagation(); return }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }}
      style={{
        position: portalTarget ? 'absolute' : 'fixed',
        top: position.top,
        right: position.right,
        transform: showConnectionPort ? 'translateY(-50%)' : undefined,
        animation: showConnectionPort ? 'none' : undefined,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {showConnectionPort && (
        <span
          data-panel-connection-menu-port
          className="pointer-events-none absolute left-[-12px] top-1/2 z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-focus bg-focus-blue"
          style={{ boxShadow: '0 0 0 4px color-mix(in srgb, var(--focus-blue) 18%, transparent)' }}
        />
      )}
      <div
        className={`w-full overflow-y-auto ${POPOVER_SURFACE} p-1.5`}
        style={{ maxHeight: portalTarget ? undefined : `calc(100vh - ${position.top + 8}px)` }}
      >
        {items.map(({ type, label, icon }) => (
          <button
            key={type}
            type="button"
            role="menuitem"
            className="flex items-center gap-2.5 w-full rounded-lg px-2.5 py-1.5 text-primary hover:bg-hover focus-visible:bg-hover transition-colors duration-100 motion-reduce:transition-none"
            onClick={() => {
              onClose()
              onPick(type)
            }}
          >
            <Icon name={icon} size={16} className="shrink-0 text-secondary" />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>,
    portalTarget ?? document.body,
  )
}

export function NewTabButton({ compact, canvasAttached, items, onPick }: {
  compact?: boolean
  canvasAttached?: boolean
  items: NewTabItem[]
  onPick: (type: string) => void
}) {
  const canvasOverlay = useContext(DockMenuPortalContext)
  const portalTarget = canvasAttached ? canvasOverlay : null
  const getPosition = useCallback((rect: DOMRect) => {
    if (portalTarget) {
      const world = portalTarget.getBoundingClientRect()
      const scale = world.width / portalTarget.offsetWidth || 1
      return {
        top: (rect.bottom - world.top) / scale + 4,
        right: portalTarget.offsetWidth - (rect.left - world.left) / scale - 220,
      }
    }
    return {
      top: rect.bottom + 4,
      right: Math.max(8, window.innerWidth - Math.max(8, rect.left) - 220),
    }
  }, [portalTarget])
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null)
  const open = !!position
  useLayoutEffect(() => {
    if (!open) return
    let frame: number
    // Canvas pan/zoom uses transforms, which do not trigger resize observers.
    const trackAnchor = () => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (rect) {
        const { top, right } = getPosition(rect)
        setPosition(current => !current || (current.top === top && current.right === right)
          ? current : { top, right })
      }
      frame = requestAnimationFrame(trackAnchor)
    }
    trackAnchor()
    return () => cancelAnimationFrame(frame)
  }, [open, getPosition])
  const close = useCallback(() => {
    setPosition(null)
    buttonRef.current?.focus()
  }, [])
  return <>
    <Tooltip label="New Tab">
      <button
        ref={buttonRef}
        type="button"
        aria-label="New Tab"
        aria-haspopup="menu"
        aria-expanded={!!position}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className={`flex shrink-0 items-center justify-center self-center rounded-[10px] text-muted hover:text-primary hover:bg-hover transition-colors duration-100 motion-reduce:transition-none cursor-pointer ${compact ? 'w-[22px] h-[22px]' : 'w-6 h-6'} ${position ? 'bg-hover text-primary' : ''}`}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setPosition((current) => current ? null : getPosition(rect))
        }}
      ><Plus size={compact ? 12 : 13} /></button>
    </Tooltip>
    <DockTabContextMenu open={!!position} position={position} items={items} onPick={onPick} onClose={close} anchorRef={buttonRef} portalTarget={portalTarget} />
  </>
}
