// A card that slides up out from behind the top edge of a bar and back, so it
// reads as part of the bar rather than a separate popover: clipped at the
// bar's top, a little narrower than the bar, with a faint shadow and a shade where the bar
// overlaps it.

import React, { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/** Length of the slide (kept in step with `.cate-slide-*` in globals.css). */
const SLIDE_MS = 200

/** How far the card is inset from each side of its bar, so the bar reads as in front. */
const INSET = 12

type Box = { left: number; bottom: number; width: number; }

export function AttachedFlyout({ bar, open, children, onMouseEnter, onMouseLeave, className = '' }: {
  /** The bar the card hangs from. */
  bar: HTMLElement | null
  open: boolean
  children: React.ReactNode
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  className?: string
}): React.ReactElement | null {
  const [mounted, setMounted] = useState(open)
  const [box, setBox] = useState<Box | null>(null)

  // Stay mounted while the card slides back behind the bar.
  useEffect(() => {
    if (open) { setMounted(true); return }
    const timer = setTimeout(() => setMounted(false), SLIDE_MS)
    return () => clearTimeout(timer)
  }, [open])

  useLayoutEffect(() => {
    if (!open || !bar) return
    const b = bar.getBoundingClientRect()
    const bottom = window.innerHeight - b.top
    setBox({ left: b.left + INSET, bottom, width: b.width - 2 * INSET })
  }, [open, bar])

  if (!mounted || !box) return null
  return createPortal(
    <div
      className="fixed z-[1000]"
      style={{
        left: box.left, bottom: box.bottom, width: box.width,
        // Clips only the bottom, so the shadow above and beside still shows. It
        // stops 1px short of the bar so the bar's own top outline stays visible.
        clipPath: 'inset(-32px -32px 1px -32px)',
        pointerEvents: open ? undefined : 'none',
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div
        className={`${open ? 'cate-slide-up-in' : 'cate-slide-down-out'} relative rounded-t-lg bg-surface-0 card-outline ${className}`}
      >
        {children}
        {/* The bar's shade falling on the card where it emerges. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2" style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.2), transparent)' }} />
      </div>
    </div>,
    document.body,
  )
}
