import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Tooltip } from '../ui/Tooltip'

interface CanvasToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  size?: 'panel' | 'zoom'
  tooltipPlacement?: 'top' | 'right'
}

export const CanvasToolbarButton = forwardRef<HTMLButtonElement, CanvasToolbarButtonProps>(function CanvasToolbarButton({
  label,
  active = false,
  size = 'panel',
  tooltipPlacement = 'top',
  className = '',
  children,
  type = 'button',
  ...props
}, ref) {
  return (
    <Tooltip label={label} placement={tooltipPlacement}>
      <button
        {...props}
        ref={ref}
        type={type}
        aria-label={label}
        aria-pressed={active || undefined}
        style={{ WebkitTapHighlightColor: 'transparent', ...props.style }}
        className={`${size === 'panel' ? 'h-9 w-9' : 'h-8 w-8'} flex items-center justify-center rounded-full ${
          active ? 'bg-hover-strong text-primary' : 'bg-transparent text-secondary'
        } hover:bg-hover-strong hover:text-primary active:scale-[0.92] transition-all duration-100 ${className}`}
      >
        {children}
      </button>
    </Tooltip>
  )
})
