import type { HTMLAttributes, ReactNode } from 'react'
import { worktreeTitleStyle } from '../lib/worktreeTitleStyle'

const AWAIT_COLOR = '#c08a5a'

interface AgentActivityTitleProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode
  running: boolean
  worktreeColor?: string
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
      style={worktreeTitleStyle(worktreeColor, running)}
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
