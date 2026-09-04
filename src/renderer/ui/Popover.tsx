import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

type DismissEvent = 'mousedown' | 'click'
const NO_TRIGGER_REFS: ReadonlyArray<RefObject<HTMLElement | null>> = []

export function useDismissableLayer({
  open,
  contentRef,
  triggerRefs = NO_TRIGGER_REFS,
  onDismiss,
  outsideEvent = 'mousedown',
  closeOnEscape = true,
}: {
  open: boolean
  contentRef: RefObject<HTMLElement | null>
  triggerRefs?: ReadonlyArray<RefObject<HTMLElement | null>>
  onDismiss: () => void
  outsideEvent?: DismissEvent
  closeOnEscape?: boolean
}): void {
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  const triggerRefsRef = useRef(triggerRefs)
  triggerRefsRef.current = triggerRefs

  useEffect(() => {
    if (!open) return
    const onOutside = (event: MouseEvent): void => {
      const target = event.target as Node
      if (contentRef.current?.contains(target)) return
      if (triggerRefsRef.current.some((ref) => ref.current?.contains(target))) return
      dismissRef.current()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (closeOnEscape && event.key === 'Escape') dismissRef.current()
    }
    document.addEventListener(outsideEvent, onOutside)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener(outsideEvent, onOutside)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [closeOnEscape, contentRef, open, outsideEvent])
}

export const POPOVER_SURFACE =
  'rounded-lg border border-strong bg-surface-4/98 backdrop-blur-xl shadow-[0_12px_32px_var(--shadow-node)]'

export type ViewportPopoverPosition = {
  top: number
  left: number
  placement: 'above' | 'below'
}

export function verticalPopoverPosition(
  rect: DOMRect,
  gap: number,
  popoverHeight?: number,
): Pick<ViewportPopoverPosition, 'top' | 'placement'> {
  const viewportMargin = 8
  const above = rect.top - gap - viewportMargin
  const below = window.innerHeight - rect.bottom - gap - viewportMargin
  const placement =
    popoverHeight != null && below >= popoverHeight
      ? 'below'
      : popoverHeight != null && above >= popoverHeight
        ? 'above'
        : below >= above
          ? 'below'
          : 'above'

  return { placement, top: placement === 'below' ? rect.bottom + gap : rect.top - gap }
}

export function useViewportPopoverPosition(
  triggerRef: RefObject<Element | null>,
  open: boolean,
  layout: (rect: DOMRect) => { left: number; gap: number; height?: number },
  popoverRef?: RefObject<HTMLElement | null>,
) {
  const [pos, setPos] = useState<ViewportPopoverPosition | null>(null)
  const layoutRef = useRef(layout)
  useLayoutEffect(() => { layoutRef.current = layout }, [layout])

  const updateRef = useRef<() => void>(() => {})
  updateRef.current = () => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const result = layoutRef.current(rect)
    const measuredHeight = popoverRef?.current?.getBoundingClientRect().height
    const next = {
      left: result.left,
      ...verticalPopoverPosition(rect, result.gap, measuredHeight || result.height),
    }
    setPos((current) => current?.top === next.top && current.left === next.left && current.placement === next.placement ? current : next)
  }

  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const update = (): void => updateRef.current()
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  useLayoutEffect(() => {
    if (open && pos) updateRef.current()
  })

  return { pos, portalTarget: typeof document === 'undefined' ? null : document.body }
}

export function PopoverSurface({
  popoverRef,
  pos,
  portalTarget,
  width,
  className = '',
  style,
  children,
}: {
  popoverRef: RefObject<HTMLDivElement>
  pos: ViewportPopoverPosition | null
  portalTarget: HTMLElement | null
  width: number
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  if (!pos || !portalTarget) return null
  return createPortal(
    <div
      ref={popoverRef}
      className={`fixed ${POPOVER_SURFACE} z-[9999] ${className}`}
      data-placement={pos.placement}
      style={{
        top: pos.top,
        left: pos.left,
        width,
        transform: pos.placement === 'above' ? 'translateY(-100%)' : undefined,
        ...style,
      }}
    >
      {children}
    </div>,
    portalTarget,
  )
}

/** Open-state scaffold used by composer controls anchored to a button. */
export function useNodePopover(
  triggerRef: RefObject<HTMLButtonElement | null>,
  layout: (rect: DOMRect) => { left: number; gap: number; height?: number },
) {
  const [open, setOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const { pos, portalTarget } = useViewportPopoverPosition(triggerRef, open, layout, popoverRef)
  useDismissableLayer({
    open,
    contentRef: popoverRef,
    triggerRefs: [triggerRef],
    onDismiss: () => setOpen(false),
  })
  return { open, setOpen, popoverRef, pos, portalTarget }
}

/** Compatibility name for the composer-facing popover surface. */
export function NodePopover({
  bodyClassName,
  ...props
}: Omit<Parameters<typeof PopoverSurface>[0], 'className'> & { bodyClassName?: string }) {
  return <PopoverSurface {...props} className={bodyClassName} />
}
