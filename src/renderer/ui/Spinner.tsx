import type { ReactNode } from 'react'
import { CircleNotch } from '@phosphor-icons/react'

interface SpinnerProps {
  size?: number
  className?: string
  label?: string
}

/** The single indeterminate activity indicator used throughout the renderer. */
export function Spinner({ size = 16, className = '', label }: SpinnerProps) {
  return (
    <span
      className={`inline-flex shrink-0 ${className}`}
      role={label ? 'status' : undefined}
      aria-label={label}
    >
      <CircleNotch
        size={size}
        aria-hidden="true"
        className="animate-spin motion-reduce:animate-none"
      />
    </span>
  )
}

interface LoadingStateProps {
  label?: ReactNode
  size?: number
  className?: string
}

/** Centered, labelled loading feedback for panels and other content surfaces. */
export function LoadingState({ label = 'Loading…', size = 18, className = '' }: LoadingStateProps) {
  return (
    <div
      className={`flex items-center justify-center gap-2 text-muted ${className}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <Spinner size={size} />
      {label != null && <span>{label}</span>}
    </div>
  )
}
