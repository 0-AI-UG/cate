// =============================================================================
// CateAgentFeedback — the Cate Agent's job stack, docked above the toolbar.
//
// Less chat, more jobs: each active/actionable todo renders as its own card that
// runs in parallel with the others. A card shows the model-derived topic as its
// title (falling back to the prompt), the prompt itself, its worktree, the
// terminals it currently controls, and the actions for its state — Stop + Edit
// while running, Approve/Dismiss for proposals, Merge/PR/Discard at review,
// Rerun for failures. The container itself is transparent; only the cards have a
// surface, so they read as floating jobs over the canvas (no panel chrome).
// Shown only while the panel is open (the toolbar button toggles it).
// =============================================================================

import React from 'react'
import {
  Play,
  Sparkle,
  X,
  Stop,
  PencilSimple,
  GitMerge,
  GitPullRequest,
  Trash,
  Terminal as TerminalIcon,
  CircleNotch,
} from '@phosphor-icons/react'
import { useTodosStore } from '../stores/todosStore'
import { useCateAgentWs } from './cateAgentStore'
import { cateAgentController } from './cateAgentController'
import { mergeTodo, openPrTodo, discardTodo } from './cateAgentReviewActions'
import { revealPanel } from '../lib/workspace/panelReveal'
import { useWorktrees, type JoinedWorktree } from '../stores/useWorktrees'
import type { Todo } from '../../shared/types'

// Actionable statuses shown as job cards, in display order. done/discarded are
// history and omitted from this transient surface.
const JOB_STATUSES: Todo['status'][] = ['in_progress', 'review', 'suggested', 'pending', 'failed']

const wtTitle = (wt: JoinedWorktree): string => wt.label || wt.branch || wt.path.split(/[/\\]/).pop() || 'worktree'

export const CateAgentFeedback: React.FC<{ workspaceId: string; rootPath: string }> = ({ workspaceId, rootPath }) => {
  const wsId = workspaceId
  const cateAgent = useCateAgentWs(wsId)
  const todos = useTodosStore((s) => s.todosByRoot[rootPath])
  const worktrees = useWorktrees(rootPath, wsId)

  const jobs = (todos ?? [])
    .filter((t) => JOB_STATUSES.includes(t.status))
    .sort((a, b) => JOB_STATUSES.indexOf(a.status) - JOB_STATUSES.indexOf(b.status))

  if (!wsId || !cateAgent.inputOpen || jobs.length === 0) return null

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 flex flex-col gap-2 max-h-[55vh] overflow-y-auto">
      {jobs.map((job) => (
        <JobCard key={job.id} job={job} wsId={wsId} rootPath={rootPath} worktrees={worktrees} />
      ))}
    </div>
  )
}

const StatusGlyph: React.FC<{ status: Todo['status'] }> = ({ status }) => {
  switch (status) {
    case 'in_progress':
      return <CircleNotch size={14} className="mt-[1px] flex-shrink-0 text-green-400 animate-spin" />
    case 'review':
      return <GitMerge size={14} className="mt-[1px] flex-shrink-0 text-amber-400" />
    case 'failed':
      return <X size={14} className="mt-[1px] flex-shrink-0 text-red-400/80" />
    default: // suggested / pending
      return <Sparkle size={14} weight="fill" className="mt-[1px] flex-shrink-0 text-blue-400" />
  }
}

const JobCard: React.FC<{ job: Todo; wsId: string; rootPath: string; worktrees: JoinedWorktree[] }> = ({
  job,
  wsId,
  rootPath,
  worktrees,
}) => {
  const removeTodo = useTodosStore((s) => s.removeTodo)
  const [busy, setBusy] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(job.title)

  const worktree = job.worktreeId ? worktrees.find((w) => w.id === job.worktreeId) : undefined
  const wtColor = worktree?.color ?? 'var(--surface-5)'
  const terminals = job.terminalNodeIds ?? []
  const title = job.topic || job.title
  const running = job.status === 'in_progress'

  const runReview = async (fn: (w: string, r: string, t: Todo) => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn(wsId, rootPath, job)
    } finally {
      setBusy(false)
    }
  }

  const submitEdit = () => {
    const t = draft.trim()
    if (!t) return
    setEditing(false)
    void cateAgentController.editJob(wsId, rootPath, job.id, t)
  }

  const btn = 'flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors disabled:opacity-40'

  return (
    <div className="rounded-2xl border border-subtle bg-surface-1 shadow-[0_8px_24px_-6px_var(--shadow-node)] px-3 py-2.5 flex flex-col gap-1.5">
      {/* Title row: status glyph + topic, with worktree pill on the right. */}
      <div className="flex items-start gap-2">
        <StatusGlyph status={job.status} />
        <div className="flex-1 min-w-0">
          <div className="text-sm leading-snug text-primary break-words">{title}</div>
          {job.topic && job.title !== job.topic && (
            <div className="text-xs leading-snug text-muted break-words">{job.title}</div>
          )}
        </div>
        {worktree && (
          <span
            className="flex-shrink-0 mt-[1px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-mono text-secondary max-w-[160px]"
            style={{
              backgroundColor: `color-mix(in srgb, ${wtColor} 18%, transparent)`,
              border: `1px solid color-mix(in srgb, ${wtColor} 45%, transparent)`,
            }}
            title={worktree.branch || worktree.path}
          >
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: wtColor }} />
            <span className="truncate">{wtTitle(worktree)}</span>
          </span>
        )}
      </div>

      {/* Note / rationale. */}
      {job.note && (
        <div className={`text-xs leading-snug break-words ${job.status === 'review' ? 'text-amber-400/90' : 'text-muted'}`}>
          {job.note}
        </div>
      )}

      {/* Controlled terminals. */}
      {terminals.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {terminals.map((tid, i) => (
            <button
              key={tid}
              onClick={() => void revealPanel(wsId, tid, { retry: true })}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-secondary hover:text-primary bg-surface-1 hover:bg-hover transition-colors"
              title="Jump to terminal"
            >
              <TerminalIcon size={11} /> {terminals.length > 1 ? `Terminal ${i + 1}` : 'Terminal'}
            </button>
          ))}
        </div>
      )}

      {/* Edit prompt (inline). */}
      {editing ? (
        <div className="flex flex-col gap-1.5 pt-0.5">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submitEdit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setEditing(false)
              }
            }}
            rows={2}
            placeholder="Edit the prompt…"
            className="w-full resize-none rounded-lg border border-subtle bg-surface-0 text-sm text-primary px-2 py-1.5 outline-none focus:border-blue-500/50 placeholder:text-muted"
          />
          <div className="flex items-center gap-1.5">
            <button onClick={submitEdit} className={`${btn} text-white bg-blue-500 hover:bg-blue-600`}>
              <Play size={10} weight="fill" /> Restart
            </button>
            <button onClick={() => setEditing(false)} className={`${btn} text-muted hover:text-primary hover:bg-hover`}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {running && (
            <>
              <button onClick={() => cateAgentController.stop(wsId, job.id)} className={`${btn} text-secondary hover:text-red-400 hover:bg-hover`}>
                <Stop size={11} weight="fill" /> Stop
              </button>
              <button onClick={() => { setDraft(job.title); setEditing(true) }} className={`${btn} text-secondary hover:text-primary hover:bg-hover`}>
                <PencilSimple size={11} /> Edit
              </button>
            </>
          )}
          {job.status === 'suggested' && (
            <>
              <button onClick={() => void cateAgentController.runTodo(wsId, rootPath, job.id)} className={`${btn} text-white bg-blue-500 hover:bg-blue-600`}>
                <Play size={10} weight="fill" /> Approve &amp; run
              </button>
              <button onClick={() => removeTodo(rootPath, job.id)} className={`${btn} text-muted hover:text-primary hover:bg-hover`}>
                <X size={10} /> Dismiss
              </button>
            </>
          )}
          {job.status === 'review' && (
            <>
              <button disabled={busy} onClick={() => void runReview(mergeTodo)} className={`${btn} text-white bg-green-600 hover:bg-green-700`}>
                <GitMerge size={11} /> Merge
              </button>
              <button disabled={busy} onClick={() => void runReview(openPrTodo)} className={`${btn} text-secondary hover:text-primary hover:bg-hover`}>
                <GitPullRequest size={11} /> PR
              </button>
              <button disabled={busy} onClick={() => void runReview(discardTodo)} className={`${btn} text-muted hover:text-red-400 hover:bg-hover`}>
                <Trash size={11} /> Discard
              </button>
            </>
          )}
          {(job.status === 'pending' || job.status === 'failed') && (
            <>
              <button onClick={() => void cateAgentController.runTodo(wsId, rootPath, job.id)} className={`${btn} text-secondary hover:text-blue-400 hover:bg-hover`}>
                <Play size={11} /> {job.status === 'failed' ? 'Rerun' : 'Run'}
              </button>
              <button onClick={() => { setDraft(job.title); setEditing(true) }} className={`${btn} text-secondary hover:text-primary hover:bg-hover`}>
                <PencilSimple size={11} /> Edit
              </button>
              <button onClick={() => removeTodo(rootPath, job.id)} className={`${btn} text-muted hover:text-red-400 hover:bg-hover`}>
                <Trash size={11} /> Remove
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
