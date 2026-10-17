import type { HTMLAttributes, ReactNode } from 'react'

type NoticeTone = 'error' | 'success' | 'info' | 'warning'

const tones: Record<NoticeTone, string> = {
  error: 'text-danger bg-danger-tint border-danger',
  success: 'text-agent-light bg-agent/10 border-agent/20',
  info: 'text-secondary bg-surface-2 border-subtle',
  warning: 'text-warning bg-warning-tint border-warning',
}

interface InlineNoticeProps extends HTMLAttributes<HTMLDivElement> {
  tone?: NoticeTone
  children: ReactNode
}

export function InlineNotice({ tone = 'info', className = '', children, ...props }: InlineNoticeProps) {
  return (
    <div
      {...props}
      role={props.role ?? (tone === 'error' ? 'alert' : 'status')}
      className={`rounded-md border px-2.5 py-1.5 text-[11px] ${tones[tone]} ${className}`}
    >
      {children}
    </div>
  )
}
