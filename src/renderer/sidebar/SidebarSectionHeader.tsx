// =============================================================================
// SidebarSectionHeader — unified header bar used by every right-sidebar view.
// Keeps title typography, height, padding, and action button styling consistent.
// =============================================================================

import React from 'react'
import { Tooltip } from '../ui/Tooltip'

interface SidebarSectionHeaderProps {
  title: string
  actions?: React.ReactNode
  /** Optional small subtitle row rendered beneath the main header (no border). */
  subtitle?: React.ReactNode
}

export const SidebarSectionHeader: React.FC<SidebarSectionHeaderProps> = ({ title, actions, subtitle }) => {
  return (
    <div className="flex-shrink-0">
      <div
        className="flex items-center min-h-[36px] px-3"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="text-[13px] text-primary flex-1 truncate">
          {title}
        </span>
        {actions && (
          <div
            className="flex items-center gap-1 -mr-1"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {actions}
          </div>
        )}
      </div>
      {subtitle && (
        <div className="px-3 py-1 text-[12px] text-muted font-medium truncate">{subtitle}</div>
      )}
    </div>
  )
}

/** Standard icon button styling for header actions. A `title` renders as the
 *  portal Tooltip (native title tooltips are flaky in Electron) plus an
 *  aria-label, instead of being passed through to the DOM. */
export const SidebarHeaderButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { spinning?: boolean }
> = ({ children, className = '', spinning, title, ...rest }) => {
  const button = (
    <button
      aria-label={title}
      {...rest}
      className={`flex items-center justify-center w-[22px] h-[22px] my-1 rounded text-secondary hover:text-primary hover:bg-hover transition-colors disabled:opacity-30 ${className}`}
    >
      <span className={spinning ? 'inline-flex opacity-60' : 'inline-flex'}>{children}</span>
    </button>
  )
  return title ? <Tooltip label={title}>{button}</Tooltip> : button
}
