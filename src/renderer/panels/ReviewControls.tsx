import React, { useEffect } from 'react'
import { ChevronsDown as CaretDoubleDown, ChevronsUp as CaretDoubleUp, Check, Code, FileSearch as FileMagnifyingGlass, Pin as PushPin } from 'lucide-react'
import type { AgentDef, AgentId } from '../../shared/agents'
import type { ReviewPanelState, WorkspaceState } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { getAgentLogoById } from '../lib/agent/agentLogos'
import { Tooltip } from '../ui/Tooltip'
import { LoadingState, Spinner } from '../ui/Spinner'

export interface AgentChoice { agent: AgentDef; ready: boolean }
type AgentAction = { kind: 'review' | 'changes' }

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
      className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors disabled:opacity-30 ${active ? 'bg-hover-strong text-primary' : 'text-muted hover:text-primary hover:bg-hover'}`}
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
    title={title}
    disabled={disabled}
    onClick={onClick}
    className="h-7 px-2.5 rounded-lg flex items-center gap-1.5 border border-subtle bg-surface-2 text-[11px] text-secondary hover:text-primary hover:bg-hover disabled:opacity-30 disabled:pointer-events-none transition-colors"
  >
    {children}
    <span>{label}</span>
  </button>
)

export function ReviewDisplayOptions({ display, update }: { display: Pick<ReviewPanelState['display'], 'wordDiff' | 'wrap'>; update: (patch: Partial<ReviewPanelState['display']>) => void }) {
  return <>
    <ReviewMenuButton label="Word differences" active={display.wordDiff} onClick={() => update({ wordDiff: !display.wordDiff })}><Code size={14} /></ReviewMenuButton>
    <ReviewMenuButton label="Wrap lines" active={display.wrap} onClick={() => update({ wrap: !display.wrap })}><PushPin size={14} /></ReviewMenuButton>
  </>
}

export function ReviewStats({ files, additions, deletions }: { files: number; additions: number; deletions: number }) {
  return <span className="text-[11px] text-muted tabular-nums mr-1">{files} files <span className="text-diff-add">+{additions}</span>{' '}<span className="text-diff-del">-{deletions}</span></span>
}

export function ReviewRunStatus({ state, workspace, workspaceId, panelId }: { state: ReviewPanelState; workspace?: WorkspaceState; workspaceId: string; panelId: string }) {
  const review = state.agentReview
  const run = review ? Object.values(workspace?.panels ?? {}).find((panel) => panel.codingAgentRun?.id === review.runId)?.codingAgentRun : undefined
  useEffect(() => {
    if (review?.status !== 'working' || !run?.endedAt) return
    const app = useAppStore.getState()
    const latest = app.getWorkspace(workspaceId)?.panels[panelId]?.reviewState
    if (latest?.agentReview?.runId !== review.runId || latest.agentReview.status !== 'working') return
    app.setPanelReviewState(workspaceId, panelId, { ...latest, agentReview: { ...review, status: 'failed', completedAt: run.endedAt } })
  }, [review, run?.endedAt, workspaceId, panelId])
  return review ? <span className={`text-[10px] mr-1 ${review.status === 'complete' ? 'text-green-400' : review.status === 'failed' ? 'text-red-400' : 'text-blue-400'}`}>Terminal review: {review.status}</span> : null
}

export function ReviewFileFilter({ value, onChange, allCollapsed, disabled, onToggleCollapsed }: { value: string; onChange: (value: string) => void; allCollapsed: boolean; disabled: boolean; onToggleCollapsed: () => void }) {
  return <div className="flex items-center gap-2 px-2 py-1.5 border-b border-subtle flex-shrink-0">
    <FileMagnifyingGlass size={14} className="text-muted" />
    <input aria-label="Filter changed files" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Filter changed files" className="bg-transparent flex-1 min-w-0 text-[12px] focus:outline-none" />
    <ToolbarButton label={allCollapsed ? 'Expand all files' : 'Collapse all files'} disabled={disabled} onClick={onToggleCollapsed}>{allCollapsed ? <CaretDoubleDown size={14} /> : <CaretDoubleUp size={14} />}</ToolbarButton>
  </div>
}

export function AgentPickerPopover({
  action,
  choices,
  selectedAgentId,
  busy,
  onSelect,
  onClose,
  onConfirm,
}: {
  action: AgentAction
  choices: AgentChoice[] | null
  selectedAgentId: AgentId | null
  busy: boolean
  onSelect: (agentId: AgentId) => void
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <div role="dialog" aria-label={action.kind === 'review' ? 'Choose terminal review CLI' : 'Choose terminal changes CLI'} className="absolute right-0 top-9 z-50 w-64 rounded-lg border border-subtle bg-surface-2 p-1.5 shadow-xl">
      <p className="px-1 pb-1.5 text-[10px] text-muted">
        {action.kind === 'review'
          ? 'Choose a terminal CLI to review this diff.'
          : 'Choose a terminal CLI to address the open review notes.'}
      </p>
      {choices === null ? (
        <LoadingState label="Checking terminal CLIs…" size={14} className="py-4 text-[10px]" />
      ) : (
        <div role="radiogroup" aria-label="Terminal CLI" className="grid grid-cols-3 gap-1">
          {choices.map(({ agent, ready }) => {
            const selected = selectedAgentId === agent.id
            const logo = getAgentLogoById(agent.id)
            return (
              <button
                key={agent.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!ready}
                title={ready ? agent.displayName : `${agent.displayName}: hooks not enabled`}
                onClick={() => onSelect(agent.id)}
                className={`relative h-12 min-w-0 rounded-md border px-1 py-1 flex flex-col items-center justify-center gap-0.5 transition-colors disabled:opacity-35 ${selected ? 'border-focus-blue bg-focus-blue/10' : 'border-transparent hover:bg-hover'}`}
              >
                {logo
                  ? <img src={logo} alt="" className="w-4 h-4 object-contain shrink-0" />
                  : <span className="w-4 h-4 shrink-0 rounded bg-surface-4 flex items-center justify-center text-[9px]">{agent.displayName[0]}</span>}
                <span className="w-full truncate text-center text-[9px] text-primary">{agent.displayName}</span>
                {!ready && <span className="absolute right-1 top-1 w-1.5 h-1.5 rounded-full bg-amber-400" />}
              </button>
            )
          })}
        </div>
      )}
      <div className="mt-1.5 flex justify-end gap-1 border-t border-subtle pt-1.5">
        <button type="button" onClick={onClose} disabled={busy} className="h-6 px-2 rounded text-[10px] text-muted hover:text-primary hover:bg-hover disabled:opacity-40">Cancel</button>
        <button type="button" onClick={onConfirm} disabled={busy || !selectedAgentId} className="h-6 px-2 rounded bg-focus-blue text-white text-[10px] disabled:opacity-40">
          {busy ? <Spinner size={14} label="Starting agent" /> : action.kind === 'review' ? 'Start review' : 'Send request'}
        </button>
      </div>
    </div>
  )
}
