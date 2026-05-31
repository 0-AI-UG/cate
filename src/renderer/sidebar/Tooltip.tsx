// =============================================================================
// Tooltip — lightweight hover label rendered via a portal (reliable in Electron
// where native `title` tooltips are flaky). Positions a small chip just below
// the wrapped element. Theme-safe (uses surface/border/text tokens).
// =============================================================================

import React, { useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  label: string
  children: React.ReactNode
}

export const Tooltip: React.FC<TooltipProps> = ({ label, children }) => {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = (e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const left = r.left + r.width / 2
    const top = r.bottom + 4
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
            className="fixed z-[100] -translate-x-1/2 pointer-events-none px-1.5 py-0.5 rounded bg-surface-2 border border-subtle text-[11px] text-primary whitespace-nowrap shadow-lg"
            style={{ top: pos.top, left: pos.left }}
          >
            {label}
          </div>,
          document.body,
        )}
    </span>
  )
}
