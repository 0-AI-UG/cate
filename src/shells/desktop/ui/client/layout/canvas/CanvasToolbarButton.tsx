import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Tooltip } from '../../../kernel/interaction'
import type { ActionId } from '@kernel/interaction/contract'

interface CanvasToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  action?: ActionId
  label: string
  active?: boolean
  tooltipPlacement?: 'top' | 'right'
  tooltipSuppressed?: boolean
}

export const CanvasToolbarButton = forwardRef<HTMLButtonElement, CanvasToolbarButtonProps>(function CanvasToolbarButton({
  label,
  action,
  active = false,
  tooltipPlacement = 'top',
  tooltipSuppressed = false,
  className = '',
  children,
  type = 'button',
  ...props
}, ref) {
  return (
    <Tooltip action={action} label={label} placement={tooltipPlacement} suppressed={tooltipSuppressed}>
      <button
        {...props}
        ref={ref}
        type={type}
        aria-label={label}
        aria-pressed={active || undefined}
        style={{ WebkitTapHighlightColor: 'transparent', ...props.style }}
        className={`h-7 w-7 shrink-0 flex items-center justify-center rounded-lg ${
          active ? 'bg-hover-strong text-primary' : 'bg-transparent text-muted'
        } hover:bg-hover-strong hover:text-primary active:scale-[0.94] transition-colors duration-100 ${className}`}
      >
        {children}
      </button>
    </Tooltip>
  )
})
