import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { popoverLayer } from './dialogLayers'

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
      // A child selector portals beside its parent, rather than inside it.
      // Follow its trigger back to the owning layer before dismissing.
      let child = target instanceof Element ? target.closest('[data-popover-owner]') : null
      const visited = new Set<Element>()
      while (child && !visited.has(child)) {
        visited.add(child)
        const owner = document.getElementById(child.getAttribute('data-popover-owner') ?? '')
        if (owner && contentRef.current?.contains(owner)) return
        child = owner?.closest('[data-popover-owner]') ?? null
      }
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
  'rounded-lg border border-white/[0.08] bg-surface-1 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.8)]'

export type ViewportPopoverPosition = {
  top: number
  left: number
  placement: 'above' | 'below'
  /** The anchor's on-screen scale (a node on a zoomed canvas), when not 1. */
  scale?: number
}

/** How much a trigger is scaled on screen: a panel on a zoomed canvas is drawn
 *  smaller than its layout size, while a portaled popover is not. */
export function anchorScale(element: Element, rect: DOMRect): number | undefined {
  const layoutWidth = element instanceof HTMLElement ? element.offsetWidth : 0
  if (!layoutWidth || !rect.width) return undefined
  const scale = rect.width / layoutWidth
  return Math.abs(scale - 1) > 0.02 ? scale : undefined
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
  layout: (rect: DOMRect, scale: number) => { left: number; gap: number; height?: number },
  popoverRef?: RefObject<HTMLElement | null>,
) {
  const [pos, setPos] = useState<ViewportPopoverPosition | null>(null)
  const layoutRef = useRef(layout)
  useLayoutEffect(() => { layoutRef.current = layout }, [layout])

  const updateRef = useRef<() => void>(() => {})
  updateRef.current = () => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const scale = anchorScale(triggerRef.current, rect)
    // `scale` is how big the popover is drawn: right-aligned layouts use
    // `width * scale`, so it still ends under its button on a zoomed canvas.
    const result = layoutRef.current(rect, scale ?? 1)
    const measuredHeight = popoverRef?.current?.getBoundingClientRect().height
    const next: ViewportPopoverPosition = {
      left: result.left,
      ...verticalPopoverPosition(rect, result.gap, measuredHeight || result.height),
      scale,
    }
    setPos((current) => current?.top === next.top && current.left === next.left && current.placement === next.placement && current.scale === next.scale ? current : next)
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
  ownerId,
  children,
}: {
  popoverRef: RefObject<HTMLDivElement>
  pos: ViewportPopoverPosition | null
  portalTarget: HTMLElement | null
  width: number
  className?: string
  style?: CSSProperties
  ownerId?: string
  children: ReactNode
}) {
  if (!pos || !portalTarget) return null
  return createPortal(
    <div
      ref={popoverRef}
      className={`fixed ${POPOVER_SURFACE} z-[9999] ${className}`}
      data-placement={pos.placement}
      data-popover-owner={ownerId}
      style={{
        zIndex: popoverLayer(),
        top: pos.top,
        left: pos.left,
        width,
        transform: pos.scale
          ? `${pos.placement === 'above' ? `translateY(-${100 * pos.scale}%) ` : ''}scale(${pos.scale})`
          : pos.placement === 'above' ? 'translateY(-100%)' : undefined,
        transformOrigin: pos.scale ? 'top left' : undefined,
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
  layout: (rect: DOMRect, scale: number) => { left: number; gap: number; height?: number },
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
