import React, { useRef } from 'react'
import { FileSearch as FileMagnifyingGlass, Terminal } from 'lucide-react'
import { Spinner, Tooltip, useDismissableLayer, useHoverIntent } from '../../kernel/interaction'
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

const ReviewActionButton: React.FC<{
  label: string
  title?: string
  disabled?: boolean
  onClick: () => void
  children?: React.ReactNode
}> = ({ label, title, disabled, onClick, children }) => (
  <button
    type="button"
    aria-label={label}
    title={title ?? label}
    disabled={disabled}
    onClick={onClick}
    className="review-action h-7 shrink-0 px-2.5 rounded-lg flex items-center justify-center gap-1.5 border border-subtle bg-surface-2 text-[11px] text-secondary hover:text-primary hover:bg-hover disabled:opacity-30 disabled:pointer-events-none transition-colors"
  >
    {children ?? <Terminal size={14} />}
    <span className="review-action-label whitespace-nowrap">{label}</span>
  </button>
)

export function ReviewStats({ files, additions, deletions }: { files: number; additions: number; deletions: number }) {
  return <span className="review-stats whitespace-nowrap text-[11px] text-muted tabular-nums mr-1" title={`${files} files, +${additions} −${deletions}`}>{files} files <span className="review-line-stats"><span className="text-diff-add">+{additions}</span>{' '}<span className="text-diff-del">-{deletions}</span></span></span>
}

export function ReviewFileFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <div className="flex items-center gap-2 px-2 py-1.5 border-b border-subtle flex-shrink-0">
    <FileMagnifyingGlass size={14} className="text-muted" />
    <input aria-label="Filter changed files" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Filter changed files" className="bg-transparent flex-1 min-w-0 text-[12px] focus:outline-none" />
  </div>
}

/** Available reviewers open on hover; a pick starts a terminal review. */
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
  const hover = useHoverIntent({
    enabled: !disabled,
    open: () => !open && onOpenChange(true),
    close: () => open && !busy && onOpenChange(false),
  })
  useDismissableLayer({ open: open && !busy, contentRef: box, onDismiss: () => onOpenChange(false) })
  const ready = choices?.filter((choice) => choice.ready).map((choice) => choice.agentId) ?? []
  return (
    <div ref={box} className="relative" onMouseEnter={hover.enter} onMouseLeave={hover.leave}>
      <ReviewActionButton
        label={label}
        disabled={disabled}
        onClick={() => {
          hover.cancel()
          onOpenChange(!open)
        }}
      >
        {busy ? <Spinner size={14} label="Starting agent" /> : <Terminal size={14} />}
      </ReviewActionButton>
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
