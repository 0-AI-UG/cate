// =============================================================================
// SidebarSectionHeader — unified header bar used by every right-sidebar view.
// Keeps title typography, height, padding, and action button styling consistent.
// =============================================================================

import React from 'react'
import { IconButton } from '../ui/Button'

interface SidebarSectionHeaderProps {
  title: string
  actions?: React.ReactNode
  /** Optional small subtitle row rendered beneath the main header (no border). */
  subtitle?: React.ReactNode
  /** Larger, bolder title. Used only by the top-level Workspace header; every
   *  other section (Source Control, Search, …) keeps the small default. */
  large?: boolean
}

export const SidebarSectionHeader: React.FC<SidebarSectionHeaderProps> = ({ title, actions, subtitle, large }) => {
  return (
    <div className="flex-shrink-0">
      <div
        className="flex items-center min-h-[36px] px-3"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span
          className={`flex-1 truncate text-primary ${large ? 'text-[18px] font-semibold' : 'text-[13px]'}`}
        >
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
> = ({ children, className = '', spinning, title, 'aria-label': ariaLabel, ...rest }) => {
  const label = typeof title === 'string' ? title : typeof ariaLabel === 'string' ? ariaLabel : 'Action'
  return (
    <IconButton
      label={label}
      loading={spinning}
      size={22}
      {...rest}
      className={`my-1 ${className}`}
    >
      {children}
    </IconButton>
  )
}
