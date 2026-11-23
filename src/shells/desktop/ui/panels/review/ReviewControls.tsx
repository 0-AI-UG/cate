import React, { useRef } from 'react'
import { Search, Terminal, X } from 'lucide-react'
import { Spinner, Tooltip, useDismissableLayer } from '../../kernel/interaction'
import type { AgentId } from '@services/agents/contract'
import type { ReviewAgentChoice } from '@panels/review/contract'
import { AgentFlyout } from '../../services/agents'

export const ToolbarButton: React.FC<{
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}> = ({ label, active, disabled, onClick, children }) => (
  <Tooltip label={label} placement="bottom">
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`w-7 h-7 shrink-0 rounded-lg flex items-center justify-center transition-colors disabled:opacity-30 ${active ? 'bg-hover-strong text-primary' : 'text-muted hover:text-primary hover:bg-hover'}`}
    >
      {children}
    </button>
  </Tooltip>
)

export function ReviewSearch({ value, autoFocus, onChange, onClose }: {
  value: string
  autoFocus: boolean
  onChange(value: string): void
  onClose(): void
}) {
  return <div className="flex h-7 min-w-0 max-w-64 flex-1 items-center gap-1 rounded-md border border-subtle bg-surface-0 px-1.5 focus-within:border-strong">
    <Search size={14} aria-hidden="true" className="shrink-0 text-muted" />
    <input autoFocus={autoFocus} aria-label="Search files and terminals" value={value} onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}
      placeholder="Search files and terminals" className="min-w-0 flex-1 bg-transparent text-xs focus:outline-none" />
    <button type="button" aria-label="Close review search" title="Close review search" onClick={onClose}
      className="flex size-5 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-primary"><X size={12} aria-hidden="true" /></button>
  </div>
}

/** A pick starts a review in a terminal. */
export function ReviewAgentButton({ label, disabled = false, busy, open, choices, onOpenChange, onPick }: {
  label: string
  disabled?: boolean
  busy: boolean
  open: boolean
  choices: ReviewAgentChoice[] | null
  onOpenChange: (open: boolean) => void
  onPick: (agentId: AgentId) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  useDismissableLayer({ open: open && !busy, contentRef: box, onDismiss: () => onOpenChange(false) })
  const ready = choices?.filter((choice) => choice.ready).map((choice) => choice.agentId) ?? []
  return (
    <div ref={box} className="relative">
      <ToolbarButton
        label={label}
        active={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        {busy ? <Spinner size={14} label="Starting agent" /> : <Terminal size={14} />}
      </ToolbarButton>
      {open && (
        <div className="absolute left-1/2 top-full z-50 pt-1.5 -translate-x-1/2">
          <AgentFlyout
            agents={ready}
            side="down"
            label="Choose terminal review CLI"
            itemLabel={(name) => `Review with ${name}`}
            disabled={busy}
            onPick={onPick}
          >
            {choices === null || busy
              ? <span className="h-9 w-9 flex items-center justify-center"><Spinner size={14} label={busy ? 'Starting agent' : 'Checking terminal CLIs'} /></span>
              : ready.length === 0
                ? <span className="px-3 py-2 whitespace-nowrap text-[10px] text-muted">No agent CLI has hooks on</span>
                : undefined}
          </AgentFlyout>
        </div>
      )}
    </div>
  )
}
