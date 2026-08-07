import { useCallback, useEffect, useMemo, useState } from 'react'
import { CaretDown } from '@phosphor-icons/react'
import type { ToolMessage } from './codingStore'
import { useAppStore } from '../../renderer/stores/appStore'
import { revealPanel } from '../../renderer/lib/workspace/panelReveal'
import { useAgentTerminalStatus, codingAgentStatusLabel } from './useAgentTerminalStatus'
import {
  codingAgentDisplayName,
  parseCodingAgentId,
  type CodingAgentRunStatus,
} from '../../shared/codingAgentRuns'
import { getAgentLogoById } from '../../renderer/lib/agent/agentLogos'
import { CateLogo } from '../../renderer/ui/CateLogo'
import { OrchestrationToolDetails } from './ChatOrchestrationToolCard'
import {
  applyCodingAgentWorktree,
  discardCodingAgentWorktree,
  keepCodingAgentWorktree,
  reviewCodingAgentWorktree,
  type CodingAgentWorktreeReview,
} from '../../renderer/lib/agent/codingAgentIntegration'
import { worktreeTitleStyle } from '../../renderer/lib/worktreeTitleStyle'

function resultObject(result: string | undefined): Record<string, unknown> {
  if (!result) return {}
  try {
    const parsed = JSON.parse(result)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function resultStatus(value: unknown): CodingAgentRunStatus | null {
  return value === 'starting' || value === 'working' || value === 'waiting'
    || value === 'ready' || value === 'stopped' || value === 'failed'
    ? value
    : null
}

/** Native card for a worker created by Cate Agent. The terminal remains a real,
 * visible canvas panel; this is its live mission-level summary and jump target. */
export function CodingAgentCard({ msg }: { msg: ToolMessage; shimmer?: boolean }) {
  const result = useMemo(() => resultObject(msg.result), [msg.result])
  const args = (msg.args ?? {}) as Record<string, unknown>
  const panelId = typeof result.panelId === 'string' ? result.panelId : ''
  const agentId = parseCodingAgentId(result.agentId ?? args.agentId)
  const agentLogo = getAgentLogoById(agentId)
  const prompt = typeof args.prompt === 'string' ? args.prompt : 'Coding task'
  const fallbackTitle = typeof result.title === 'string'
    ? result.title
    : typeof args.title === 'string'
      ? args.title
      : prompt.replace(/\s+/g, ' ').slice(0, 54)
  const workspace = useAppStore((state) =>
    state.workspaces.find((ws) => panelId && ws.panels[panelId]),
  )
  const workspaceId = workspace?.id ?? ''
  const panel = workspace?.panels[panelId]
  const run = panel?.codingAgentRun
  const title = panel?.title || fallbackTitle
  const terminalStatus = useAgentTerminalStatus(workspaceId, panelId)
  const [expanded, setExpanded] = useState(false)
  const running = msg.status === 'running' || msg.status === 'pending'
  const agentLabel = agentId ? codingAgentDisplayName(agentId) : 'Coding agent'
  const label = `${title} · ${agentLabel}`
  const canonicalStatus = terminalStatus.runStatus ?? resultStatus(result.status)
  const status = msg.error
    ? 'Failed'
    : canonicalStatus
      ? codingAgentStatusLabel(canonicalStatus)
      : running ? 'Starting…' : 'Created'
  const canOpenTerminal = Boolean(panelId && workspaceId)
  const canReview = Boolean(canOpenTerminal && run?.worktreeId)
  const titleShimmers = canonicalStatus === 'working' || (!canonicalStatus && running)
  const worktreeColor = (workspace?.worktrees?.length ?? 0) >= 2
    ? workspace?.worktrees?.find((worktree) => worktree.id === run?.worktreeId)?.color
    : undefined

  return (
    <div
      className="text-[12px] cate-fade-in"
      data-tool-name="create_coding_agent"
    >
      <div className="flex min-w-0 items-center gap-2">
        <CateLogo
          size={15}
          aria-label="Cate"
          className="shrink-0 text-[rgb(var(--agent-rgb))]"
        />
        <button
          data-coding-agent-terminal-link
          aria-label={`Open ${label} terminal`}
          title={canOpenTerminal ? `Open terminal · ${status}` : status}
          disabled={!canOpenTerminal}
          className={`inline-flex h-6 min-w-0 max-w-[280px] items-center gap-1.5 text-[11px] text-primary transition-colors ${
            canOpenTerminal ? 'hover:text-primary' : 'cursor-default'
          }`}
          onClick={() => { void revealPanel(workspaceId, panelId) }}
        >
          {agentLogo && (
            <img
              src={agentLogo}
              alt=""
              width={11}
              height={11}
              draggable={false}
              className="shrink-0"
            />
          )}
          <span
            className={`truncate min-w-0 ${titleShimmers ? 'cate-notif-pulse' : ''}`}
            style={worktreeTitleStyle(worktreeColor, titleShimmers)}
          >
            {title}
          </span>
          {canonicalStatus === 'waiting' && (
            <span className="cate-await-indicator shrink-0" aria-label="awaiting input">
              <span className="cate-await-dot" style={{ backgroundColor: '#c08a5a' }} />
            </span>
          )}
        </button>
        <button
          aria-label="Show coding agent details"
          aria-expanded={expanded}
          className="flex h-6 w-5 shrink-0 items-center justify-center text-muted hover:text-primary"
          onClick={() => setExpanded((value) => !value)}
        >
          <CaretDown size={11} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {expanded && (
        <div className="mt-2 space-y-2 pl-[23px]">
          <OrchestrationToolDetails msg={msg} />
          {terminalStatus.line && (
            <div className="truncate font-mono text-[10.5px] text-muted">
              {terminalStatus.line}
            </div>
          )}
        </div>
      )}
      {canReview && canonicalStatus === 'ready' && (
        <CodingAgentIntegrationActions
          workspaceId={workspaceId}
          panelId={panelId}
          title={title}
          ownsWorktree={Boolean(run?.ownsWorktree)}
          appliedToBranch={run?.appliedToBranch}
          kept={Boolean(run?.keptAt)}
        />
      )}
    </div>
  )
}

function CodingAgentIntegrationActions({
  workspaceId,
  panelId,
  title,
  ownsWorktree,
  appliedToBranch,
  kept,
}: {
  workspaceId: string
  panelId: string
  title: string
  ownsWorktree: boolean
  appliedToBranch?: string
  kept: boolean
}) {
  const [review, setReview] = useState<CodingAgentWorktreeReview | null>(null)
  const [reviewExpanded, setReviewExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const loadReview = useCallback(async (expand = false) => {
    setBusy(true)
    setError(null)
    try {
      setReview(await reviewCodingAgentWorktree(workspaceId, panelId))
      if (expand) setReviewExpanded(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not review this worker.')
    } finally {
      setBusy(false)
    }
  }, [panelId, workspaceId])

  useEffect(() => {
    if (!review && !appliedToBranch) void loadReview()
  }, [appliedToBranch, loadReview, review])

  const apply = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const current = review ?? await reviewCodingAgentWorktree(workspaceId, panelId)
      setReview(current)
      if (!current.canApply) {
        setError(current.message ?? 'This worker is not ready to apply.')
        setReviewExpanded(true)
        return
      }
      if (!window.confirm(
        `Apply “${title}” to ${current.baseBranch}?\n\nThis merges ${current.branch} into your current branch.`,
      )) return
      const result = await applyCodingAgentWorktree(workspaceId, panelId, current.baseBranch)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setNotice(`Applied to ${result.branch}. The worker is still available for verification.`)
      setReview(await reviewCodingAgentWorktree(workspaceId, panelId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not apply this worker.')
    } finally {
      setBusy(false)
    }
  }

  const discard = async (): Promise<void> => {
    const dirtyWarning = review?.dirty ? ' Its uncommitted changes will be lost.' : ''
    const appliedWarning = appliedToBranch
      ? ` Applied changes on ${appliedToBranch} will remain.`
      : ''
    if (!window.confirm(
      `${appliedToBranch ? 'Clean up' : 'Discard'} “${title}” and remove its worktree?${dirtyWarning}${appliedWarning}`,
    )) return
    setBusy(true)
    setError(null)
    try {
      await discardCodingAgentWorktree(workspaceId, panelId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not discard this worker.')
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 ml-[23px] rounded-md border border-subtle bg-surface-1 p-2 text-[10.5px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          className="rounded bg-surface-2 px-2 py-1 text-primary hover:bg-hover-strong disabled:opacity-50"
          disabled={busy}
          onClick={() => { void loadReview(true) }}
        >
          {busy && !review ? 'Reviewing…' : 'Review changes'}
        </button>
        {!appliedToBranch && (
          <button
            className="rounded bg-agent px-2 py-1 text-white hover:bg-agent-light disabled:opacity-50"
            disabled={busy || review?.canApply === false}
            title={review?.canApply === false ? review.message : undefined}
            onClick={() => { void apply() }}
          >
            Apply to {review?.baseBranch ?? 'current branch'}
          </button>
        )}
        {!appliedToBranch && !kept && (
          <button
            className="rounded bg-surface-2 px-2 py-1 text-primary hover:bg-hover-strong disabled:opacity-50"
            disabled={busy}
            onClick={() => keepCodingAgentWorktree(workspaceId, panelId)}
          >
            Keep worktree
          </button>
        )}
        {ownsWorktree && (
          <button
            className="rounded px-2 py-1 text-danger hover:bg-danger/10 disabled:opacity-50"
            disabled={busy}
            onClick={() => { void discard() }}
          >
            {appliedToBranch ? 'Clean up' : 'Discard'}
          </button>
        )}
        {appliedToBranch && <span className="text-[#34C759]">Applied to {appliedToBranch}</span>}
        {!appliedToBranch && kept && <span className="text-muted">Kept for later.</span>}
      </div>
      {notice && <div className="mt-1.5 text-[#34C759]">{notice}</div>}
      {error && <div className="mt-1.5 text-danger">{error}</div>}
      {reviewExpanded && review && (
        <div className="mt-2 space-y-1 border-t border-subtle pt-2 text-muted">
          <div>
            {review.commits.length} commit{review.commits.length === 1 ? '' : 's'} · {' '}
            {review.files.length} changed file{review.files.length === 1 ? '' : 's'}
            {review.dirty ? ` · ${review.workingFiles.length} uncommitted` : ''}
          </div>
          {review.message && <div className="text-warning">{review.message}</div>}
          {review.commits.length > 0 && (
            <ul className="space-y-0.5 font-mono">
              {review.commits.map((commit) => (
                <li key={commit.hash}>{commit.hash.slice(0, 8)} {commit.message}</li>
              ))}
            </ul>
          )}
          {review.files.length > 0 && (
            <div className="font-mono">{review.files.map((file) => `${file.status} ${file.path}`).join('\n')}</div>
          )}
          {review.diff && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 text-[10px] text-primary">
              {review.diff}
            </pre>
          )}
          {review.truncated && <div>Diff preview was truncated.</div>}
        </div>
      )}
    </div>
  )
}
