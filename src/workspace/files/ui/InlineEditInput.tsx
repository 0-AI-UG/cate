// =============================================================================
// InlineEditInput — shared inline text field for sidebar rename / create forms.
// Centralises the Enter-commit / Escape-cancel / click-swallow wiring that the
// file tree (rename + create) and the workspace tab (rename) all reimplemented.
// Callers keep their own state + focus/select-on-mount wiring via the forwarded
// ref; only className and the Escape-time stopPropagation behaviour differ, so
// both are parameterised.
// =============================================================================

import React, { forwardRef } from 'react'

export interface InlineEditInputProps {
  value: string
  onChange: (value: string) => void
  /** Commit (Enter / blur). */
  onSubmit: () => void
  /** Cancel (Escape). */
  onCancel: () => void
  className?: string
  placeholder?: string
  /** When true, keydown events are stopped from bubbling (file tree rows rely on
   *  this so typing doesn't trip the tree's keyboard navigation; the workspace
   *  tab does NOT). */
  stopKeyPropagation?: boolean
}

export const InlineEditInput = forwardRef<HTMLInputElement, InlineEditInputProps>(
  ({ value, onChange, onSubmit, onCancel, className, placeholder, stopKeyPropagation }, ref) => (
    <input
      ref={ref}
      className={className}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onSubmit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSubmit()
        if (e.key === 'Escape') onCancel()
        if (stopKeyPropagation) e.stopPropagation()
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  ),
)

InlineEditInput.displayName = 'InlineEditInput'
