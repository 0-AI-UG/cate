import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'

const AWAIT_COLOR = '#c08a5a'

interface AgentActivityTitleProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode
  running: boolean
  worktreeColor?: string
}

// A worktree tints the title, not the icon (the icon may be an agent logo
// <img>, which ignores `color`). While running the title shimmers: the
// `cate-notif-pulse` class sweeps a white highlight over the worktree color;
// without a worktree color the class's default muted to primary sweep applies.
function titleStyle(color: string | undefined, running: boolean): CSSProperties | undefined {
  if (!color) return undefined
  if (!running) return { color }
  return { '--shimmer-bright': '#ffffff', '--shimmer-dim': color } as CSSProperties
}

export function AgentActivityTitle({
  children,
  running,
  worktreeColor,
  className = '',
  ...props
}: AgentActivityTitleProps) {
  return (
    <span
      {...props}
      className={`${running ? 'cate-notif-pulse' : ''} ${className}`}
      style={titleStyle(worktreeColor, running)}
    >
      {children}
    </span>
  )
}

export function AwaitingIndicator({ className = '' }: { className?: string }) {
  return (
    <span className={`cate-await-indicator shrink-0 ${className}`} aria-label="awaiting input">
      <span className="cate-await-dot" style={{ backgroundColor: AWAIT_COLOR }} />
    </span>
  )
}
