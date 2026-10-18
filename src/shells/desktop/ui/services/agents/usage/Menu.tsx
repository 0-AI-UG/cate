// A popover menu anchored to its trigger (the upstream `Menu`): the
// overview's workspace menu.

import { useRef, useState, type ReactNode } from 'react'
import { PopoverSurface, useDismissableLayer, useViewportPopoverPosition } from '../../../kernel/interaction'

export function Menu({ trigger, triggerClassName, width = 320, children }: {
  trigger: (open: boolean) => ReactNode
  triggerClassName: string
  width?: number
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const { pos, portalTarget } = useViewportPopoverPosition(triggerRef, open, (rect) => ({
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    gap: 6,
  }), popoverRef)
  useDismissableLayer({ open, contentRef: popoverRef, triggerRefs: [triggerRef], onDismiss: () => setOpen(false) })
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-popup-open={open ? '' : undefined}
        onClick={() => setOpen((v) => !v)}
        className={triggerClassName}
      >
        {trigger(open)}
      </button>
      <PopoverSurface popoverRef={popoverRef} pos={pos} portalTarget={portalTarget} width={width} className="max-w-[calc(100vw-2rem)] rounded-xl p-1 text-[13px]">
        <div role="menu">{children}</div>
      </PopoverSurface>
    </>
  )
}

export function MenuItem({ icon, onClick, children }: { icon?: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-primary hover:bg-hover">
      {icon}
      {children}
    </button>
  )
}

export const MenuSeparator = () => <div role="separator" className="mx-1 my-1 h-px bg-[var(--border-subtle)]" />
