import React, { useRef } from 'react'
import { ChevronsDown as CaretDoubleDown, ChevronsUp as CaretDoubleUp, Check, Code, FileSearch as FileMagnifyingGlass, Pin as PushPin, Terminal } from 'lucide-react'
import { Spinner, Tooltip, useDismissableLayer, useHoverIntent } from '../../kernel/interaction'
import type { AgentId } from '@services/agents/contract'
import type { ReviewAgentChoice, ReviewAgentRun, ReviewDisplay } from '@panels/review/contract'
import { AgentFlyout } from '../../services/agents'

export type AgentAction = { kind: 'review' | 'changes' }

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

export const ReviewMenuButton: React.FC<{
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}> = ({ label, active, disabled, onClick, children }) => (
  <button
    type="button"
    role="menuitem"
    disabled={disabled}
    onClick={onClick}
    className="w-full h-8 px-2.5 rounded-md flex items-center gap-2 text-[11px] text-secondary hover:text-primary hover:bg-hover disabled:opacity-30 disabled:pointer-events-none"
  >
    <span className="w-4 flex items-center justify-center text-muted">{children}</span>
    <span className="flex-1 text-left">{label}</span>
    <span className="w-4 flex items-center justify-center">{active && <Check size={12} />}</span>
  </button>
)

export const ReviewActionButton: React.FC<{
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

export function ReviewDisplayOptions({ display, update }: { display: Pick<ReviewDisplay, 'wordDiff' | 'wrap'>; update: (patch: Partial<ReviewDisplay>) => void }) {
  return <>
    <ReviewMenuButton label="Word differences" active={display.wordDiff} onClick={() => update({ wordDiff: !display.wordDiff })}><Code size={14} /></ReviewMenuButton>
    <ReviewMenuButton label="Wrap lines" active={display.wrap} onClick={() => update({ wrap: !display.wrap })}><PushPin size={14} /></ReviewMenuButton>
  </>
}

export function ReviewStats({ files, additions, deletions }: { files: number; additions: number; deletions: number }) {
  return <span className="review-stats whitespace-nowrap text-[11px] text-muted tabular-nums mr-1" title={`${files} files, +${additions} −${deletions}`}>{files} files <span className="review-line-stats"><span className="text-diff-add">+{additions}</span>{' '}<span className="text-diff-del">-{deletions}</span></span></span>
}

export function ReviewRunStatus({ review }: { review: ReviewAgentRun | undefined }) {
  return review ? <span title={`Terminal review: ${review.status}`} className={`review-run-status whitespace-nowrap text-[10px] mr-1 ${review.status === 'complete' ? 'text-green-400' : review.status === 'failed' ? 'text-red-400' : 'text-blue-400'}`}><span className="review-run-prefix">Terminal review: </span>{review.status}</span> : null
}

export function ReviewFileFilter({ value, onChange, allCollapsed, disabled, onToggleCollapsed }: { value: string; onChange: (value: string) => void; allCollapsed: boolean; disabled: boolean; onToggleCollapsed: () => void }) {
  return <div className="flex items-center gap-2 px-2 py-1.5 border-b border-subtle flex-shrink-0">
    <FileMagnifyingGlass size={14} className="text-muted" />
    <input aria-label="Filter changed files" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Filter changed files" className="bg-transparent flex-1 min-w-0 text-[12px] focus:outline-none" />
    <ToolbarButton label={allCollapsed ? 'Expand all files' : 'Collapse all files'} disabled={disabled} onClick={onToggleCollapsed}>{allCollapsed ? <CaretDoubleDown size={14} /> : <CaretDoubleUp size={14} />}</ToolbarButton>
  </div>
}

/** A review action whose agent CLIs spring open under it on hover, like the
 *  agents over the new-terminal button; a pick starts that one. A click runs
 *  `onClick` when given (a known agent), else opens the column at once. */
export function AgentActionButton({ action, label, title, disabled = false, busy, open, choices, onOpenChange, onClick, onPick, children }: {
  action: AgentAction
  label: string
  title?: string
  disabled?: boolean
  busy: boolean
  open: boolean
  choices: ReviewAgentChoice[] | null
  onOpenChange: (open: boolean) => void
  onClick?: () => void
  onPick: (agentId: AgentId) => void
  children?: React.ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const hover = useHoverIntent({
    enabled: !disabled,
    open: () => !open && onOpenChange(true),
    close: () => open && !busy && onOpenChange(false),
  })
  useDismissableLayer({ open: open && !busy, contentRef: box, onDismiss: () => onOpenChange(false) })
  const ready = choices?.filter((choice) => choice.ready).map((choice) => choice.agentId) ?? []
  const review = action.kind === 'review'
  return (
    <div ref={box} className="relative" onMouseEnter={hover.enter} onMouseLeave={hover.leave}>
      <ReviewActionButton
        label={label}
        title={open ? '' : title}
        disabled={disabled}
        onClick={() => {
          hover.cancel()
          if (onClick) onClick()
          else onOpenChange(!open)
        }}
      >
        {children}
      </ReviewActionButton>
      {open && (
        <div className="absolute left-1/2 top-full z-50 pt-1.5 -translate-x-1/2">
          <AgentFlyout
            agents={ready}
            side="down"
            label={review ? 'Choose terminal review CLI' : 'Choose terminal changes CLI'}
            itemLabel={(name) => (review ? `Review with ${name}` : `Send to ${name}`)}
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
