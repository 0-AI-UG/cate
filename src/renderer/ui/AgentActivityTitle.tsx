import type { HTMLAttributes, ReactNode } from 'react'
import { worktreeTitleStyle } from '../lib/worktreeTitleStyle'

const AWAIT_COLOR = 'color-mix(in srgb, var(--activity-orange) 70%, var(--text-primary))'

interface AgentActivityTitleProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode
  worktreeColor?: string
}

// Static on purpose: an infinite title shimmer kept the window compositing at
// display refresh rate for as long as any agent ran. Running state is shown by
// RunningIndicator next to the title instead.
export function AgentActivityTitle({
  children,
  worktreeColor,
  className = '',
  ...props
}: AgentActivityTitleProps) {
  return (
    <span
      {...props}
      className={className}
      style={worktreeTitleStyle(worktreeColor)}
    >
      {children}
    </span>
  )
}

/** Running agent: a static dashed ring (outline). Waiting is the filled dot
 *  below; idle shows neither. No animation, so it costs no frames. */
export function RunningIndicator({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`cate-running-indicator shrink-0 ${className}`}
      width={11}
      height={11}
      viewBox="0 0 24 24"
      role="img"
      aria-label="agent running"
      style={{ color: 'var(--text-secondary)' }}
    >
      <circle
        cx={12}
        cy={12}
        r={9}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.6}
        strokeDasharray="4.2 3.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function AwaitingIndicator({ className = '' }: { className?: string }) {
  return (
    <span className={`cate-await-indicator shrink-0 ${className}`} aria-label="awaiting input">
      <span className="cate-await-dot" style={{ backgroundColor: AWAIT_COLOR }} />
    </span>
  )
}
