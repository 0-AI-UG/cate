// Panel-type menu shared by the new-tab buttons.

import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { PanelType } from '../../shared/types'
import { SPLIT_MENU_PANEL_TYPES } from '../../shared/panels'
import { PANEL_REGISTRY } from '../panels/registry'
import { POPOVER_SURFACE } from '../ui/Popover'

export type SplitMenuItem = { type: PanelType; label: string; Icon: React.ComponentType<any> }

// Available panel types in display order.
export const SPLIT_MENU_ITEMS: SplitMenuItem[] = [
  ...SPLIT_MENU_PANEL_TYPES.map((type) => ({
    type,
    label: PANEL_REGISTRY[type].label,
    Icon: PANEL_REGISTRY[type].icon,
  })),
]

export interface DockTabContextMenuProps {
  open: boolean
  position: { top: number; right: number } | null
  items: SplitMenuItem[]
  onPick: (type: PanelType) => void
  onClose: () => void
  portalTarget?: HTMLElement | null
  anchorRef?: React.RefObject<HTMLButtonElement>
}

export function DockTabContextMenu({ open, position, items, onPick, onClose, anchorRef, portalTarget }: DockTabContextMenuProps) {
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
      aria-label="New Tab"
      className={`dock-new-tab-menu pointer-events-auto z-[1000] w-[220px] max-w-[calc(100vw-16px)] overflow-y-auto ${POPOVER_SURFACE} p-1.5 text-[13px]`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') { onClose(); event.stopPropagation(); return }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }}
      style={{ position: portalTarget ? 'absolute' : 'fixed', top: position.top, right: position.right, maxHeight: portalTarget ? undefined : `calc(100vh - ${position.top + 8}px)` }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map(({ type, label, Icon }) => (
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
          <Icon size={16} className="shrink-0 text-secondary" />
          <span>{label}</span>
        </button>
      ))}
    </div>,
    portalTarget ?? document.body,
  )
}
