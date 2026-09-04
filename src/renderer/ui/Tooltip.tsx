// =============================================================================
// Tooltip — lightweight hover label rendered via a portal (reliable in Electron
// where native `title` tooltips are flaky). Positions a small chip just below
// the wrapped element. Theme-safe (uses surface/border/text tokens).
// =============================================================================

import React, { cloneElement, isValidElement, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  label: string
  placement?: 'top' | 'bottom' | 'right' | 'left'
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>
}

export const Tooltip: React.FC<TooltipProps> = ({ label, placement = 'bottom', children }) => {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tooltipId = useId()

  const show = (el: HTMLElement, delay = 250): void => {
    if (timer.current) clearTimeout(timer.current)
    const r = el.getBoundingClientRect()
    const left =
      placement === 'right' ? r.right + 6 : placement === 'left' ? r.left - 6 : r.left + r.width / 2
    const top =
      placement === 'top'
        ? r.top - 4
        : placement === 'right' || placement === 'left'
          ? r.top + r.height / 2
          : r.bottom + 4
    timer.current = setTimeout(() => setPos({ top, left }), delay)
  }
  const hide = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setPos(null)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  if (!isValidElement(children)) return children
  const describedBy = [children.props['aria-describedby'], pos ? tooltipId : null]
    .filter(Boolean)
    .join(' ') || undefined
  const child = cloneElement(children, {
    'aria-describedby': describedBy,
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
      children.props.onMouseEnter?.(event)
      if (!event.defaultPrevented) show(event.currentTarget)
    },
    onMouseLeave: (event: React.MouseEvent<HTMLElement>) => {
      children.props.onMouseLeave?.(event)
      hide()
    },
    onMouseDown: (event: React.MouseEvent<HTMLElement>) => {
      children.props.onMouseDown?.(event)
      hide()
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      children.props.onFocus?.(event)
      if (!event.defaultPrevented) show(event.currentTarget, 0)
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      children.props.onBlur?.(event)
      hide()
    },
  })

  return (
    <>
      {child}
      {pos &&
        createPortal(
          <div
            id={tooltipId}
            role="tooltip"
            className="fixed z-[100] pointer-events-none px-1.5 py-0.5 rounded bg-surface-2 border border-subtle text-[11px] text-primary whitespace-nowrap shadow-lg"
            style={{
              top: pos.top,
              left: pos.left,
              transform:
                placement === 'top'
                  ? 'translate(-50%, -100%)'
                  : placement === 'right'
                    ? 'translateY(-50%)'
                    : placement === 'left'
                      ? 'translate(-100%, -50%)'
                      : 'translateX(-50%)',
            }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  )
}
