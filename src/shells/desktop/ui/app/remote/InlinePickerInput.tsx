// The shared, fixed-height input row for the picker's expandable actions.

import { useId, useRef, type ReactNode } from 'react'
import { AlertCircle, ArrowRight, X } from 'lucide-react'
import { IconButton, Tooltip } from '../../kernel/interaction'

export function InlinePickerInput({ icon, label, placeholder, value, onChange, onSubmit, onCancel, actionLabel, busyLabel, busy = false, disabled = false, error, hint }: {
  icon: ReactNode
  label: string
  placeholder: string
  value: string
  onChange(value: string): void
  onSubmit(): void
  onCancel(): void
  actionLabel: string
  busyLabel?: string
  busy?: boolean
  disabled?: boolean
  error?: string | null
  hint?: string
}): JSX.Element {
  const errorId = useId()
  const form = useRef<HTMLFormElement>(null)
  const cancel = () => {
    const list = form.current?.closest<HTMLElement>('[role="listbox"]')
    onCancel()
    list?.focus()
  }
  return (
    <form
      ref={form}
      className="flex h-8 items-center gap-2 rounded-md bg-hover px-2"
      aria-label={actionLabel}
      onSubmit={(e) => { e.preventDefault(); if (!busy && !disabled && value.trim()) onSubmit() }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); cancel() }
      }}
    >
      <Tooltip label={error ?? hint ?? label}>
        <span tabIndex={error ? 0 : undefined} className={`shrink-0 ${error ? 'text-danger' : 'text-muted'}`}>
          {error ? <AlertCircle size={14} /> : icon}
        </span>
      </Tooltip>
      <input
        autoFocus
        aria-label={label}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        title={error ?? undefined}
        value={value}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`min-w-0 flex-1 h-7 rounded-md border bg-surface-5 px-2 font-mono text-[13px] text-primary outline-none placeholder:text-muted focus:border-focus-blue ${error ? 'border-danger' : 'border-subtle'}`}
      />
      {error && <span id={errorId} role="alert" className="sr-only">{error}</span>}
      <IconButton size={24} label={busy ? busyLabel ?? actionLabel : actionLabel} type="submit" loading={busy} disabled={disabled || !value.trim()}><ArrowRight size={14} /></IconButton>
      <IconButton size={20} label="Cancel" disabled={busy} onClick={cancel}><X size={13} /></IconButton>
    </form>
  )
}
