import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Tooltip } from './Tooltip'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

const base = 'inline-flex items-center justify-center gap-1.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-default'
const sizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2 text-[11px]',
  md: 'h-8 px-3 text-[13px]',
}
const variants: Record<ButtonVariant, string> = {
  primary: 'font-medium bg-focus-blue text-white hover:opacity-90 transition-opacity',
  secondary: 'font-medium border border-subtle text-secondary hover:text-primary hover:bg-hover',
  ghost: 'text-secondary hover:text-primary hover:bg-hover',
  danger: 'text-muted hover:text-danger hover:bg-danger-tint',
}

export function buttonClassName(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md'): string {
  return `${base} ${sizes[size]} ${variants[variant]}`
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  loadingLabel?: string
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  loadingLabel,
  disabled,
  className = '',
  children,
  type = 'button',
  ...props
}, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`${buttonClassName(variant, size)} ${className}`}
    >
      {loading && <Spinner size={size === 'sm' ? 11 : 14} />}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  )
})

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right'
  size?: number
  tone?: 'default' | 'danger'
  loading?: boolean
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  label,
  tooltipPlacement = 'bottom',
  size = 28,
  tone = 'default',
  loading = false,
  disabled,
  className = '',
  children,
  type = 'button',
  ...props
}, ref) {
  const button = (
    <button
      {...props}
      ref={ref}
      type={type}
      aria-label={label}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={`inline-flex shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-40 disabled:cursor-default ${
        tone === 'danger' ? 'text-muted hover:text-danger hover:bg-danger-tint' : 'text-secondary hover:text-primary hover:bg-hover'
      } ${className}`}
      style={{ width: size, height: size, ...props.style }}
    >
      {loading ? <Spinner size={Math.min(15, size - 10)} /> : children}
    </button>
  )
  return <Tooltip label={label} placement={tooltipPlacement}>{button}</Tooltip>
})
