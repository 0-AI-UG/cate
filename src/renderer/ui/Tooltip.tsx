// =============================================================================
// Tooltip — lightweight hover label rendered via a portal (reliable in Electron
// where native `title` tooltips are flaky). Positions a small chip just below
// the wrapped element. Theme-safe (uses surface/border/text tokens).
// =============================================================================

import React, { useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  label: string
  placement?: 'top' | 'bottom' | 'right'
  children: React.ReactNode
}

export const Tooltip: React.FC<TooltipProps> = ({ label, placement = 'bottom', children }) => {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = (e: React.MouseEvent): void => {
    // The wrapper is `display: contents` (no layout box), so its own rect is all
    // zeros and would pin the chip to the top-left corner. Measure the wrapped
    // child element instead, which carries the real geometry.
    const host = e.currentTarget as HTMLElement
    const el = (host.firstElementChild as HTMLElement | null) ?? host
    const r = el.getBoundingClientRect()
    const left = placement === 'right' ? r.right + 6 : r.left + r.width / 2
    const top =
      placement === 'top' ? r.top - 4 : placement === 'right' ? r.top + r.height / 2 : r.bottom + 4
    timer.current = setTimeout(() => setPos({ top, left }), 250)
  }
  const hide = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setPos(null)
  }

  return (
    <span className="contents" onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide}>
      {children}
      {pos &&
        createPortal(
          <div
            className="fixed z-[100] pointer-events-none px-1.5 py-0.5 rounded bg-surface-2 border border-subtle text-[11px] text-primary whitespace-nowrap shadow-lg"
            style={{
              top: pos.top,
              left: pos.left,
              transform:
                placement === 'top'
                  ? 'translate(-50%, -100%)'
                  : placement === 'right'
                    ? 'translateY(-50%)'
                    : 'translateX(-50%)',
            }}
          >
            {label}
          </div>,
          document.body,
        )}
    </span>
  )
}
