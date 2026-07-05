// =============================================================================
// CateAgentFeedback — the Cate Agent's job stack, docked above the toolbar.
//
// Less chat, more jobs: each active/actionable todo renders as its own card that
// runs in parallel with the others. A card shows the model-derived topic as its
// title (falling back to the prompt), its worktree, the
// terminals it currently controls, and the actions for its state — Stop + Edit
// while running, Approve/Dismiss for proposals, Merge/PR/Discard at review,
// Rerun for failures. The container itself is transparent; only the cards have a
// surface, so they read as floating jobs over the canvas (no panel chrome).
//
// Below the cards (newest at the very bottom, nearest the input) flow the recent
// feed lines — the observer's remarks and errors — so the agent can say something
// WITHOUT proposing a todo (otherwise a bare remark would set the attention ring
// but show nothing when the panel opens). Kept compact (a short tail, not a
// scrollback) so it stays FYI, not chat. The stack scrolls without a visible
// scrollbar; a down-caret button appears when it isn't scrolled to the bottom.
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
  CircleNotch,
  CheckCircle,
  CaretDown,
  Trophy,
  WarningCircle,
  MagnifyingGlass,
  ArrowsSplit,
} from '@phosphor-icons/react'
import { useShallow } from 'zustand/react/shallow'
import { useTodosStore } from '../stores/todosStore'
import { useAppStore } from '../stores/appStore'
import { useCateAgentWs, useCateAgentStore, type CateAgentFeedKind } from './cateAgentStore'
import { cateAgentController } from './cateAgentController'
import { mergeTodo, openPrTodo, discardTodo, removeTodoWithCleanup } from './cateAgentReviewActions'
import { revealPanel } from '../lib/workspace/panelReveal'
import { useWorktrees, type JoinedWorktree } from '../stores/useWorktrees'
import { worktreeTitleStyle } from '../lib/worktreeTitleStyle'
import { panelRowLabel } from '../sidebar/WorkspaceTab'
import { TabIcon } from '../docking/DockTabBar'
import { useAgentInfoByPanel } from '../hooks/useAgentPanelInfo'
import { Markdown } from '../../agent/renderer/ChatMarkdown'
import type { Todo, Iteration, IterationStatus } from '../../shared/types'

// How many feed lines to keep visible. The feed is a transient FYI surface, not a
// transcript — show only the latest turn (everything since the last user line),
// and never more than this many, so the observer's remarks don't pile into chat.
const MAX_VISIBLE_FEED = 6

const FEED_KIND_CLASS: Record<CateAgentFeedKind, string> = {
  user: 'text-primary',
  agent: 'text-secondary',
  status: 'text-muted',
  error: 'text-red-400',
}

// Actionable statuses shown as job cards, in display order. done/discarded are
// history and omitted from this transient surface — EXCEPT a `done` job the
// orchestrator actually carried out, which lingers (last) so the user can see the
// result and dismiss it. That covers both an `answer` (output) and a completed
// non-git code task (it ran terminals but has no worktree to land, so it settles
// to `done`); without this such a task would silently vanish on completion.
const JOB_STATUSES: Todo['status'][] = ['in_progress', 'review', 'suggested', 'pending', 'failed']

const jobRank = (t: Todo): number => {
  const i = JOB_STATUSES.indexOf(t.status)
  return i === -1 ? JOB_STATUSES.length : i
}

const isFinishedJob = (t: Todo): boolean =>
  t.status === 'done' && (!!t.output || (t.terminalNodeIds?.length ?? 0) > 0)

const wtTitle = (wt: JoinedWorktree): string => wt.label || wt.branch || wt.path.split(/[/\\]/).pop() || 'worktree'

export const CateAgentFeedback: React.FC<{ workspaceId: string; rootPath: string }> = ({ workspaceId, rootPath }) => {
  const wsId = workspaceId
  const cateAgent = useCateAgentWs(wsId)
  const todos = useTodosStore((s) => s.todosByRoot[rootPath])
  const worktrees = useWorktrees(rootPath, wsId)

  const jobs = (todos ?? [])
    .filter((t) => JOB_STATUSES.includes(t.status) || isFinishedJob(t))
    .sort((a, b) => jobRank(a) - jobRank(b))

  // Recent feed lines: the latest turn (since the last user line), capped so the
  // observer's remarks read as a short FYI rather than a growing transcript.
  const feed = cateAgent.feed
  const dismissFeedItem = useCateAgentStore((s) => s.dismissFeedItem)
  const lastUserIdx = feed.map((f) => f.kind).lastIndexOf('user')
  const visibleFeed = (lastUserIdx >= 0 ? feed.slice(lastUserIdx) : feed).slice(-MAX_VISIBLE_FEED)

  // Stick to the bottom (newest, nearest the input) as content grows — but only
  // while the user is already there, so scrolling up to read isn't yanked back. A
  // down-caret button (below) lets them jump back when they've scrolled away.
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const atBottomRef = React.useRef(true)
  const [showJump, setShowJump] = React.useState(false)

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    atBottomRef.current = atBottom
    setShowJump(!atBottom)
  }

  const scrollToBottom = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }

  React.useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight
      setShowJump(false)
    } else {
      setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight >= 24)
    }
  }, [jobs.length, visibleFeed.length])

  // The observer's transient "what am I looking at" line — the only place the live
  // `status` is surfaced. Shown ONLY while observing (no job card exists for it), so
  // it never restates a running job the cards already own.
  const showStatus = cateAgent.activity === 'observing' && !!cateAgent.status

  if (!wsId || !cateAgent.inputOpen) return null
  if (jobs.length === 0 && visibleFeed.length === 0 && !showStatus) return null

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2">
      <div ref={scrollRef} onScroll={onScroll} className="no-scrollbar flex flex-col gap-2 max-h-[55vh] overflow-y-auto">
        {showStatus && (
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted">
            <MagnifyingGlass size={12} weight="bold" className="flex-shrink-0 text-blue-400/80 animate-pulse" />
            <span className="truncate">{cateAgent.status}</span>
          </div>
        )}
        {jobs.map((job) => (
          <JobCard key={job.id} job={job} wsId={wsId} rootPath={rootPath} worktrees={worktrees} />
        ))}

        {visibleFeed.map((item) => (
          <div
            key={item.id}
            className="group/feed relative rounded-2xl border border-subtle bg-surface-1 shadow-[0_8px_24px_-6px_var(--shadow-node)] px-3 py-2 pr-8"
          >
            <div className={`text-sm leading-snug break-words ${FEED_KIND_CLASS[item.kind]}`}>
              {item.kind === 'user' ? <span className="text-muted">You: </span> : null}
              {item.text}
            </div>
            <button
              onClick={() => dismissFeedItem(wsId, item.id)}
              title="Dismiss"
              className="absolute top-1.5 right-1.5 p-1 rounded text-muted opacity-0 group-hover/feed:opacity-100 hover:text-primary hover:bg-hover transition-opacity"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>

      {showJump && (
        <button
          onClick={scrollToBottom}
          title="Jump to latest"
          className="absolute bottom-2 left-1/2 -translate-x-1/2 p-1.5 rounded-full border border-subtle bg-surface-1 text-secondary shadow-[0_8px_24px_-6px_var(--shadow-node)] hover:text-primary hover:bg-hover transition-colors"
        >
          <CaretDown size={16} weight="bold" />
        </button>
      )}
    </div>
  )
}

const StatusGlyph: React.FC<{ status: Todo['status'] }> = ({ status }) => {
  switch (status) {
    case 'in_progress':
      return <CircleNotch size={14} className="mt-[1px] flex-shrink-0 text-green-400 animate-spin" />
    case 'review':
      return <GitMerge size={14} className="mt-[1px] flex-shrink-0 text-amber-400" />
    case 'done':
      return <CheckCircle size={14} weight="fill" className="mt-[1px] flex-shrink-0 text-green-400" />
    case 'failed':
      return <X size={14} className="mt-[1px] flex-shrink-0 text-red-400/80" />
    default: // suggested / pending
      return <Sparkle size={14} weight="fill" className="mt-[1px] flex-shrink-0 text-blue-400" />
  }
}

const IterationStatusGlyph: React.FC<{ status: IterationStatus }> = ({ status }) => {
  switch (status) {
    case 'running':
      return <CircleNotch size={12} className="flex-shrink-0 text-green-400 animate-spin" />
    case 'verifying':
      return <MagnifyingGlass size={12} className="flex-shrink-0 text-blue-400 animate-pulse" />
    case 'passed':
      return <CheckCircle size={12} weight="fill" className="flex-shrink-0 text-green-400" />
    case 'failed':
      return <X size={12} className="flex-shrink-0 text-red-400/80" />
    case 'error':
      return <WarningCircle size={12} className="flex-shrink-0 text-amber-400" />
    case 'finished':
      return <CheckCircle size={12} className="flex-shrink-0 text-secondary" />
    default:
      return <CircleNotch size={12} className="flex-shrink-0 text-muted" />
  }
}

// One controlled terminal as a compact CHIP: the panel's icon (agent logo when a
// CLI is detected, like the tabs/sidebar) + its title, tinted in the worktree color
// and SHIMMERING while its agent is running (no glyph — that's the one spinner the
// card already shows top-left). Click to jump to the terminal; the user watches the
// actual output on the canvas. Mirrors the sidebar panel rows (TabIcon +
// panelRowLabel + worktreeTitleStyle + cate-notif-pulse).
const TerminalChip: React.FC<{ wsId: string; panelId: string }> = ({ wsId, panelId }) => {
  // Resolve the panel from WHICHEVER workspace actually owns it — not just the one
  // the feedback renders under. A job card's wsId is the canvas's workspace, which
  // isn't always the workspace the cate-agent created the terminal in; keying only
  // off wsId makes both the title (here) AND the agent logo/shimmer
  // (useAgentInfoByPanel, also keyed by workspace) miss together. Prefer wsId, then
  // any workspace holding the panel (panel ids are globally unique), and key the
  // status lookup off that SAME owner so the logo and shimmer resolve too. Mirrors
  // CanvasNode.resolvePanel's cross-workspace fallback. When NO workspace holds the
  // panel (the terminal was closed, or the id is stale) the chip renders nothing —
  // there's no live terminal to represent, so a placeholder would only mislead.
  const { ownerWsId, type, label, color } = useAppStore(
    useShallow((s) => {
      const ws =
        s.workspaces.find((w) => w.id === wsId && w.panels[panelId]) ??
        s.workspaces.find((w) => w.panels[panelId])
      const panel = ws?.panels[panelId]
      const worktrees = ws?.worktrees ?? []
      // Match the sidebar/tab rule: only tint when the workspace has parallel work.
      const wt =
        worktrees.length >= 2
          ? worktrees.find((w) => w.id === panel?.worktreeId) ?? worktrees.find((w) => w.path === ws?.rootPath)
          : undefined
      return {
        ownerWsId: ws?.id,
        type: panel?.type ?? 'terminal',
        label: panel ? panelRowLabel(panel) : null,
        color: wt?.color,
      }
    }),
  )
  const info = useAgentInfoByPanel(ownerWsId)[panelId]
  const isRunning = info?.state === 'running'
  // No live panel found → don't render a chip at all.
  if (!ownerWsId || !label) return null
  return (
    <button
      onClick={() => void revealPanel(ownerWsId, panelId, { retry: true })}
      title={`Jump to ${label}`}
      className="inline-flex items-center gap-1 rounded-full bg-transparent hover:bg-hover-strong px-1.5 py-0.5 transition-colors"
    >
      {/* Icon stays untinted — it may be an agent logo (<img>, which ignores color),
          matching how the tabs/sidebar tint the title but not the icon. */}
      <span className="flex-shrink-0 flex items-center text-secondary">
        <TabIcon type={type} size={11} logo={info?.logo} agentName={info?.name} />
      </span>
      <span
        className={`text-[10px] font-mono text-secondary truncate max-w-[160px] ${isRunning ? 'cate-notif-pulse' : ''}`}
        style={worktreeTitleStyle(color, isRunning)}
      >
        {label}
      </span>
    </button>
  )
}

// The job's worktree as the same collapsing chip the terminal/agent panels use
// (WorktreePill): an ArrowsSplit icon filled in the worktree color, collapsed to
// the icon alone until hovered, then growing to reveal the worktree label.
const JobWorktreePill: React.FC<{ worktree: JoinedWorktree }> = ({ worktree }) => {
  const [hovered, setHovered] = React.useState(false)
  const color = worktree.color ?? 'var(--text-muted)'
  return (
    <span
      className="flex-shrink-0 mt-[1px] inline-flex items-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={worktree.branch || worktree.path}
      style={{
        height: 18,
        maxWidth: 220,
        gap: hovered ? 4 : 0,
        padding: hovered ? '0 9px 0 7px' : '0 4px',
        borderRadius: 9,
        // Filled in the worktree color, toned toward black so white text stays legible.
        backgroundColor: `color-mix(in srgb, ${color} 92%, black)`,
        color: '#fff',
        fontSize: 10,
        fontWeight: 600,
        lineHeight: 1,
        letterSpacing: 0.2,
        textShadow: '0 1px 1px rgba(0,0,0,0.3)',
        transition: 'gap 150ms ease, padding 150ms ease',
      }}
    >
      <ArrowsSplit size={11} weight="bold" style={{ flexShrink: 0 }} />
      <span
        style={{
          maxWidth: hovered ? 180 : 0,
          opacity: hovered ? 1 : 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          transition: 'max-width 150ms ease, opacity 150ms ease',
        }}
      >
        {wtTitle(worktree)}
      </span>
    </span>
  )
}

// The loop progress for a code job: the goal plus a row per live agent. The round
// tally and per-iteration counts are dropped — the agent rows (and the canvas)
// already show what's running; the card only needs the goal and the agents.
const IterationSection: React.FC<{ job: Todo; wsId: string }> = ({ job, wsId }) => {
  // Only reached for a parallel race (more than one live attempt), under the
  // "Attempts" field — each attempt keeps its boxed, enumerated framing. The goal is
  // rendered separately as the card's Task field.
  const iters = (job.iterations ?? []).filter((i) => i.status !== 'cancelled')
  if (iters.length === 0) return null

  return (
    <div className="flex flex-col gap-1.5">
      {iters.map((it, i) => (
        <IterationRow
          key={it.id}
          it={it}
          index={i}
          framed
          winner={job.recommendedIterationId === it.id}
          wsId={wsId}
        />
      ))}
    </div>
  )
}

const IterationRow: React.FC<{ it: Iteration; index: number; framed: boolean; winner: boolean; wsId: string }> = ({
  it,
  index,
  framed,
  winner,
  wsId,
}) => {
  const body = (
    <>
      {framed && (
        <div className="flex items-center gap-1.5">
          {/* A running iteration's spinner just duplicates the agent rows' own spinners
              below — show the iteration glyph only once the status diverges from theirs
              (verifying / passed / failed / …). */}
          {it.status !== 'running' && <IterationStatusGlyph status={it.status} />}
          {winner && <Trophy size={11} weight="fill" className="flex-shrink-0 text-green-400" />}
          {/* Enumerate the iteration rather than echo the agent name (which the rows below
              already show) — an iteration isn't "the codex one", it's iteration N. */}
          <span className="text-[10px] text-muted">Iteration {index + 1}</span>
        </div>
      )}
      {it.verify && (
        <div className={`text-[11px] leading-snug break-words line-clamp-3 ${it.verify.met ? 'text-secondary' : 'text-red-400/80'}`}>
          {it.verify.reason}
        </div>
      )}
      {it.agents.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {it.agents.map((a) => (
            <TerminalChip key={a.terminalId} wsId={wsId} panelId={a.terminalId} />
          ))}
        </div>
      )}
    </>
  )
  if (!framed) return <div className="flex flex-col gap-1">{body}</div>
  return (
    <div
      className={`rounded-lg border px-2 py-1.5 flex flex-col gap-1 ${
        winner ? 'border-green-500/50 bg-green-500/10' : 'border-subtle bg-surface-0'
      }`}
    >
      {body}
    </div>
  )
}

// The shared label column for every detail row: a fixed-width, uppercase tag so all
// values line up at the same left edge — replacing the old lone goal icon + hanging
// indent with one consistent structure.
const FIELD_LABEL = 'flex-shrink-0 w-[4.25rem] text-left text-[11px] font-semibold uppercase tracking-wide text-muted'

// A static labeled row (no collapse) — for values that are a single line or otherwise
// not foldable: the agent chips, the markdown answer, the boxed parallel attempts.
const FieldRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-start gap-1.5">
    <span className={`${FIELD_LABEL} mt-[2px]`}>{label}</span>
    <div className="flex-1 min-w-0">{children}</div>
  </div>
)

// A labeled TEXT row that collapses ONLY when its value wraps past one line — a
// one-liner has nothing to fold to, so it stays static (no toggle, no dimming). When
// it does overflow, the label toggles between the clamped first line and the full text.
const JobField: React.FC<{ label: string; text: string; tone?: string; defaultOpen?: boolean }> = ({
  label,
  text,
  tone = 'text-secondary',
  defaultOpen = false,
}) => {
  const [open, setOpen] = React.useState(defaultOpen)
  const [multiline, setMultiline] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  // Measured unclamped on first layout (and whenever the text changes): if the natural
  // height is more than ~one line, the row is collapsible.
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 16
    setMultiline(el.scrollHeight > lh * 1.6)
  }, [text])
  const clamp = multiline && !open
  return (
    <div className="flex items-start gap-1.5">
      {multiline ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={open ? 'Collapse' : 'Expand'}
          className={`${FIELD_LABEL} mt-[1px] hover:text-secondary transition-colors truncate`}
        >
          {label}
        </button>
      ) : (
        <span className={`${FIELD_LABEL} mt-[1px] truncate`}>{label}</span>
      )}
      <div
        ref={ref}
        onClick={clamp ? () => setOpen(true) : undefined}
        className={`flex-1 min-w-0 text-xs leading-snug break-words ${tone} ${clamp ? 'line-clamp-1 cursor-pointer' : ''}`}
      >
        {text}
      </div>
    </div>
  )
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

  // The job's worktree id is only copied onto the todo at review; while iterating it
  // lives on each iteration. Resolve from both, and show the card pill ONLY when a
  // single worktree is in play — parallel iterations each have their own, and the
  // colored terminal chips already disambiguate those.
  const wtIds = new Set<string>()
  if (job.worktreeId) wtIds.add(job.worktreeId)
  for (const it of job.iterations ?? []) if (it.worktreeId) wtIds.add(it.worktreeId)
  const worktree = wtIds.size === 1 ? worktrees.find((w) => w.id === [...wtIds][0]) : undefined
  const terminals = job.terminalNodeIds ?? []
  const hasWorktree = !!job.worktreeId || (job.iterations?.some((i) => i.worktreeId) ?? false)
  const title = job.topic || job.title
  const running = job.status === 'in_progress'

  // A single attempt renders as flat Result + Agents fields; only a parallel race
  // (more than one live attempt) keeps the boxed, enumerated per-attempt framing.
  const iters = (job.iterations ?? []).filter((i) => i.status !== 'cancelled')
  const framed = iters.length > 1
  const lastVerify = iters.length ? iters[iters.length - 1].verify : undefined
  // The live agent chips: the union of every iteration's agents AND the todo's own
  // terminal ids, deduped. Which side holds the ids shifts across a job's life (agents
  // live on iterations while looping, on the todo for non-loop jobs), so take both —
  // keying off only one left the Agents row empty in exactly the states that moved them.
  const chipIds = new Set<string>()
  for (const it of iters) for (const a of it.agents ?? []) chipIds.add(a.terminalId)
  for (const tid of terminals) chipIds.add(tid)
  const flatChipIds = [...chipIds]

  const runReview = async (fn: (w: string, r: string, t: Todo) => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn(wsId, rootPath, job)
    } finally {
      setBusy(false)
    }
  }

  const confirmAndDiscard = async () => {
    const choice = await window.electronAPI?.confirmDiscardJob?.({
      hasWorktree,
      terminalCount: terminals.length,
    })
    if (choice !== 'discard') return
    await runReview(discardTodo)
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
          {/* Topic (or the raw prompt until one exists) — never both. Echoing the
              prompt under a topic that paraphrases it read as a stutter. */}
          <div className="text-sm leading-snug text-primary break-words">{title}</div>
        </div>
        {worktree && <JobWorktreePill worktree={worktree} />}
      </div>

      {/* Detail as labeled, independently-collapsible fields. Each label toggles only
          its own value, so the verbose bits (the ask, the rationale) sit collapsed to a
          one-line preview by default while the outcome stays open. */}
      <div className="flex flex-col gap-1">
        {job.goal && <JobField label="Task" text={job.goal} />}

        {job.note && (
          <JobField label="Note" text={job.note} tone={job.status === 'review' ? 'text-secondary' : 'text-muted'} />
        )}

        {job.output && (
          <FieldRow label="Answer">
            <div className="rounded-lg bg-surface-0 border border-subtle px-2.5 py-2 text-xs leading-relaxed text-primary max-h-60 overflow-y-auto">
              <Markdown text={job.output} />
            </div>
          </FieldRow>
        )}

        {framed ? (
          // A parallel race: each attempt keeps its own boxed verdict + agents.
          <FieldRow label="Attempts">
            <IterationSection job={job} wsId={wsId} />
          </FieldRow>
        ) : (
          <>
            {lastVerify && (
              <JobField
                label="Result"
                defaultOpen
                text={lastVerify.reason}
                tone={lastVerify.met ? 'text-secondary' : 'text-red-400/80'}
              />
            )}
            {flatChipIds.length > 0 && (
              <FieldRow label="Agents">
                <div className="flex flex-wrap items-center gap-1.5">
                  {flatChipIds.map((tid) => (
                    <TerminalChip key={tid} wsId={wsId} panelId={tid} />
                  ))}
                </div>
              </FieldRow>
            )}
          </>
        )}
      </div>

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
          {job.interrupted && (
            <>
              <button onClick={() => void cateAgentController.continueJob(wsId, rootPath, job.id)} className={`${btn} text-white bg-blue-500 hover:bg-blue-600`}>
                <Play size={10} weight="fill" /> Continue
              </button>
              <button disabled={busy} onClick={() => void confirmAndDiscard()} className={`${btn} text-muted hover:text-red-400 hover:bg-hover`}>
                <Trash size={11} /> Discard
              </button>
            </>
          )}
          {job.status === 'review' && !job.interrupted && (
            <>
              <button disabled={busy} onClick={() => void runReview(mergeTodo)} className={`${btn} text-white bg-green-600 hover:bg-green-700`}>
                <GitMerge size={11} /> Merge
              </button>
              <button disabled={busy} onClick={() => void runReview(openPrTodo)} className={`${btn} text-secondary hover:text-primary hover:bg-hover`}>
                <GitPullRequest size={11} /> PR
              </button>
              <button disabled={busy} onClick={() => void confirmAndDiscard()} className={`${btn} text-muted hover:text-red-400 hover:bg-hover`}>
                <Trash size={11} /> Discard
              </button>
            </>
          )}
          {job.status === 'done' && (
            <button onClick={() => removeTodo(rootPath, job.id)} className={`${btn} text-muted hover:text-primary hover:bg-hover`}>
              <X size={10} /> Dismiss
            </button>
          )}
          {(job.status === 'pending' || job.status === 'failed') && !job.interrupted && (
            <>
              <button onClick={() => void cateAgentController.runTodo(wsId, rootPath, job.id)} className={`${btn} text-secondary hover:text-blue-400 hover:bg-hover`}>
                <Play size={11} /> {job.status === 'failed' ? 'Rerun' : 'Run'}
              </button>
              <button onClick={() => { setDraft(job.title); setEditing(true) }} className={`${btn} text-secondary hover:text-primary hover:bg-hover`}>
                <PencilSimple size={11} /> Edit
              </button>
              <button disabled={busy} onClick={() => void runReview(removeTodoWithCleanup)} className={`${btn} text-muted hover:text-red-400 hover:bg-hover`}>
                <Trash size={11} /> Remove
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
