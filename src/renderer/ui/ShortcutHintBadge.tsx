// =============================================================================
// ShortcutHintBadge — Small floating badge showing a keyboard shortcut key.
// Ported from ShortcutHintBadge.swift (ShortcutHintBadgeView)
// =============================================================================

import React from 'react'

interface ShortcutHintBadgeProps {
  /** Badge label text, e.g. "T", "\u21E7B", "\u21E7E", "-", "=", "0" */
  label: string
  className?: string
}

export const ShortcutHintBadge: React.FC<ShortcutHintBadgeProps> = ({
  label,
  className = '',
}) => {
  return (
    <span
      className={`
        inline-flex items-center gap-0.5
        bg-surface-6 backdrop-blur-sm
        border border-subtle
        text-[11px] font-semibold text-primary
        px-2 py-0.5
        rounded-full
        shadow-sm
        animate-in fade-in duration-150
        ${className}
      `}
    >
      <span className="text-[9px] font-semibold">{'\u2318'}</span>
      <span>{label}</span>
    </span>
  )
}
