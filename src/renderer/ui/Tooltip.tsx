// =============================================================================
// Tooltip — lightweight hover label rendered via a portal (reliable in Electron
// where native `title` tooltips are flaky). Positions a small chip just below
// the wrapped element. Theme-safe (uses surface/border/text tokens).
// =============================================================================

import React, { cloneElement, isValidElement, useEffect, useLayoutEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { displayString, type ShortcutAction } from '../../shared/types'
import { useResolvedShortcuts } from '../stores/shortcutStore'

interface TooltipProps {
  action?: ShortcutAction
  label: string
  placement?: 'top' | 'bottom' | 'right' | 'left'
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>
}

export const Tooltip: React.FC<TooltipProps> = ({ label, action, placement = 'bottom', children }) => {
  const shortcuts = useResolvedShortcuts()
  const binding = action ? shortcuts[action] : undefined
  const text = binding?.key ? `${label} (${displayString(binding)})` : label
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tooltipId = useId()

  const show = (el: HTMLElement, delay = 250): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setAnchor(el), delay)
  }

  const hide = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setAnchor(null)
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

  // Measure before paint so the first visible frame already fits the window.
  useLayoutEffect(() => {
    const tooltip = tooltipRef.current
    if (!anchor || !tooltip) return
    const position = () => {
      const rect = anchor.getBoundingClientRect()
      const { width, height } = tooltip.getBoundingClientRect()
      const margin = 8
      const gap = placement === 'left' || placement === 'right' ? 6 : 4
      let side = placement
      if (side === 'right' && rect.right + gap + width > window.innerWidth - margin
        && rect.left - gap - width >= margin) side = 'left'
      else if (side === 'left' && rect.left - gap - width < margin
        && rect.right + gap + width <= window.innerWidth - margin) side = 'right'
      else if (side === 'bottom' && rect.bottom + gap + height > window.innerHeight - margin
        && rect.top - gap - height >= margin) side = 'top'
      else if (side === 'top' && rect.top - gap - height < margin
        && rect.bottom + gap + height <= window.innerHeight - margin) side = 'bottom'

      const left = side === 'right' ? rect.right + gap
        : side === 'left' ? rect.left - gap - width : rect.left + (rect.width - width) / 2
      const top = side === 'top' ? rect.top - gap - height
        : side === 'bottom' ? rect.bottom + gap : rect.top + (rect.height - height) / 2
      tooltip.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - width - margin))}px`
      tooltip.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`
      tooltip.style.visibility = 'visible'
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [anchor, placement, text])

  if (!isValidElement(children)) return children
  const describedBy = [children.props['aria-describedby'], anchor ? tooltipId : null]
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
      {anchor &&
        createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            className="fixed z-[100] pointer-events-none px-1.5 py-0.5 rounded bg-surface-2 border border-subtle text-[11px] text-primary whitespace-normal shadow-lg"
            style={{
              visibility: 'hidden',
              width: 'max-content',
              maxWidth: 'calc(100vw - 16px)',
              overflowWrap: 'anywhere',
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  )
}
