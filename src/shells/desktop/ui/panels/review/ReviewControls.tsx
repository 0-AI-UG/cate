import React, { useRef } from 'react'
import { Terminal } from 'lucide-react'
import { SearchField, Spinner, Tooltip, useDismissableLayer, useHoverIntent } from '../../kernel/interaction'
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
      className={`w-[var(--ctl-h)] h-[var(--ctl-h)] shrink-0 rounded-[var(--node-tab-radius,6px)] flex items-center justify-center transition-colors disabled:opacity-30 ${active ? 'bg-hover-strong text-primary' : 'text-muted hover:text-primary hover:bg-hover'}`}
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
    className="review-action h-[var(--ctl-h)] shrink-0 px-2 rounded-[var(--node-tab-radius,6px)] flex items-center justify-center gap-1.5 bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] text-[11px] text-secondary hover:text-primary hover:bg-hover disabled:opacity-30 disabled:pointer-events-none transition-colors"
  >
    {children ?? <Terminal size={14} />}
    <span className="review-action-label whitespace-nowrap">{label}</span>
  </button>
)

export function ReviewStats({ files, additions, deletions }: { files: number; additions: number; deletions: number }) {
  return <span className="review-stats whitespace-nowrap text-[11px] text-muted tabular-nums mr-1" title={`${files} files, +${additions} −${deletions}`}>{files} files <span className="review-line-stats"><span className="text-diff-add">+{additions}</span>{' '}<span className="text-diff-del">-{deletions}</span></span></span>
}

/** Inline in the toolbar, same 24px height as every other control there. */
export function ReviewFileFilter({ value, onChange, onClose }: { value: string; onChange: (value: string) => void; onClose: () => void }) {
  return <SearchField autoFocus value={value} onValueChange={onChange} placeholder="Filter changed files"
    containerClassName="!h-[var(--ctl-h)] w-44 min-w-0 shrink !gap-1.5 !px-2 [&_input]:!text-xs"
    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }} />
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
              ? <span className="h-7 w-full flex items-center justify-center"><Spinner size={14} label={busy ? 'Starting agent' : 'Checking terminal CLIs'} /></span>
              : ready.length === 0
                ? <span className="px-3 py-2 whitespace-nowrap text-[10px] text-muted">No agent CLI has hooks on</span>
                : undefined}
          </AgentFlyout>
        </div>
      )}
    </div>
  )
}
