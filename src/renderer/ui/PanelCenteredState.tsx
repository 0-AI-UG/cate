import type { ReactNode } from 'react'

export function PanelCenteredState({
  icon,
  title,
  description,
  actions,
  className = '',
}: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex h-full w-full flex-col items-center justify-center bg-surface-4 p-4 text-center text-secondary ${className}`}>
      {icon && <div className="mb-2 text-muted">{icon}</div>}
      <div className="text-sm font-medium text-primary">{title}</div>
      {description && <div className="mt-1 max-w-md text-xs text-muted">{description}</div>}
      {actions && <div className="mt-3 flex items-center gap-2">{actions}</div>}
    </div>
  )
}
