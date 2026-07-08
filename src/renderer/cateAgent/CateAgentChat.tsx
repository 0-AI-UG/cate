// =============================================================================
// CateAgentChat — the Cate Agent's floating window, docked above the toolbar.
//
// The FRONT DOOR is the OBSERVER: opening the agent shows a compact, read-only
// timeline of what it has watched — a single accent rail, one dot + relative time
// per remark, newest at the bottom. The window is only as tall as that content
// needs. Which view is shown (observer, or a specific chat) is chosen from the
// picker in the toolbar bar — there is no tab strip here.
//
// Selecting a CHAT clears the observer view and GROWS the window into that chat's
// transcript: a stream of TYPED blocks on one flat surface — a markdown answer
// (`text`), a code task's plan (`plan`), its parallel-attempts grid (`attempts`),
// its land actions (`result`), or a delegated canvas task (`canvas`). Tool blocks
// are calm left-accent RAILS, not boxed cards, so the thread reads as one
// conversation. Live blocks bind to the chat's `run` while it goes, then freeze to
// a snapshot so the transcript survives a reload.
//
// The card's height is measured from its content, so opening, closing, and the
// observer↔chat switch all animate purely as a grow/shrink (no fade or scale).
// =============================================================================

import React from 'react'
import {
  X,
  Stop,
  Play,
  GitMerge,
  GitPullRequest,
  Trash,
  CircleNotch,
  CheckCircle,
  Trophy,
  WarningCircle,
  MagnifyingGlass,
  ArrowsSplit,
  SquaresFour,
  Eye,
  Check,
} from '@phosphor-icons/react'
import { useShallow } from 'zustand/react/shallow'
import { useChatsStore } from '../stores/chatsStore'
import { useAppStore } from '../stores/appStore'
import { useCateAgentWs, useCateAgentStore, type CateAgentFeedItem, type CateAgentFeedKind } from './cateAgentStore'
import { cateAgentController } from './cateAgentController'
import { deriveTopic } from './cateAgentTools'
import { mergeChat, openPrChat, discardChat, type ReviewResult } from './cateAgentReviewActions'
import { revealPanel } from '../lib/workspace/panelReveal'
import { useWorktrees, type JoinedWorktree } from '../stores/useWorktrees'
import { worktreeTitleStyle } from '../lib/worktreeTitleStyle'
import { panelRowLabel } from '../sidebar/WorkspaceTab'
import { TabIcon } from '../docking/DockTabBar'
import { useAgentInfoByPanel } from '../hooks/useAgentPanelInfo'
import { Markdown } from '../../agent/renderer/ChatMarkdown'
import type {
  Chat,
  ChatMessage,
  ChatAttemptsMessage,
  ChatCanvasMessage,
  ChatPlanMessage,
  ChatResultMessage,
  ChatTextMessage,
  Iteration,
  IterationStatus,
} from '../../shared/types'

// How many observer feed lines to keep visible (a transient FYI, not a transcript).
const MAX_VISIBLE_FEED = 6

// The small label that titles each tool rail.
const LBL = 'text-[10px] font-semibold tracking-[0.04em] text-muted'

const FEED_KIND_CLASS: Record<CateAgentFeedKind, string> = {
  user: 'text-primary',
  agent: 'text-secondary',
  status: 'text-muted',
  error: 'text-red-400',
}

const wtTitle = (wt: JoinedWorktree): string => wt.label || wt.branch || wt.path.split(/[/\\]/).pop() || 'worktree'

// --- shared block pieces -----------------------------------------------------

const IterationStatusGlyph: React.FC<{ status: IterationStatus }> = ({ status }) => {
  switch (status) {
    case 'running':
      return <span className="flex-shrink-0 mt-[3px] w-2 h-2 rounded-full bg-green-400" />
    case 'verifying':
      return <MagnifyingGlass size={12} className="flex-shrink-0 text-blue-400" />
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

// One controlled terminal as a compact CHIP: the panel's icon (agent logo when a CLI
// is detected) + its title, tinted in the worktree color and SHIMMERING while its
// agent runs. Click to jump to the terminal. Resolves the panel from whichever
// workspace owns it (panel ids are globally unique).
const TerminalChip: React.FC<{ wsId: string; panelId: string }> = ({ wsId, panelId }) => {
  const { ownerWsId, type, label, color } = useAppStore(
    useShallow((s) => {
      const ws =
        s.workspaces.find((w) => w.id === wsId && w.panels[panelId]) ??
        s.workspaces.find((w) => w.panels[panelId])
      const panel = ws?.panels[panelId]
      const worktrees = ws?.worktrees ?? []
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
  if (!ownerWsId || !label) return null
  return (
    <button
      onClick={() => void revealPanel(ownerWsId, panelId, { retry: true })}
      title={`Jump to ${label}`}
      className="inline-flex items-center gap-1 rounded-full bg-transparent hover:bg-hover-strong px-1.5 py-0.5 transition-colors"
    >
      <span className="flex-shrink-0 flex items-center text-secondary">
        <TabIcon type={type} size={11} logo={info?.logo} agentName={info?.name} />
      </span>
      <span
        className="text-[10px] font-mono text-secondary truncate max-w-[160px]"
        style={worktreeTitleStyle(color, false)}
      >
        {label}
      </span>
    </button>
  )
}

// The run's worktree as the collapsing pill the terminal/agent panels use: an
// ArrowsSplit icon in the worktree color, collapsed to the icon until hovered.
const RunWorktreePill: React.FC<{ worktree: JoinedWorktree }> = ({ worktree }) => {
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

// One attempt as a calm flat row: a status glyph + the verifier's verdict (or a
// "working" placeholder), with a trophy on the winner and the losers dimmed. The
// controlled terminals hang below as chips.
const IterationRow: React.FC<{ it: Iteration; index: number; multi: boolean; winner: boolean; wsId: string }> = ({
  it,
  index,
  multi,
  winner,
  wsId,
}) => {
  const bad = it.verify && !it.verify.met
  return (
    <div className={`flex flex-col gap-1 ${multi && !winner ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-1.5">
        <span className="flex-shrink-0 mt-[1px]">
          <IterationStatusGlyph status={it.status} />
        </span>
        {winner && multi && <Trophy size={11} weight="fill" className="flex-shrink-0 mt-[1px] text-green-400" />}
        <div className={`text-[11.5px] leading-snug break-words ${bad ? 'text-red-400/80' : 'text-secondary'}`}>
          {multi && <span className="text-muted">#{index + 1} · </span>}
          {it.verify ? it.verify.reason : <span className={it.status === 'running' || it.status === 'verifying' ? 'cate-notif-pulse' : 'text-muted'}>Working</span>}
        </div>
      </div>
      {it.agents.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pl-[18px]">
          {it.agents.map((a) => (
            <TerminalChip key={a.terminalId} wsId={wsId} panelId={a.terminalId} />
          ))}
        </div>
      )}
    </div>
  )
}

// --- typed message blocks (calm flat: bubbles for chat, rails for tools) ------

const TextBlock: React.FC<{ msg: ChatTextMessage }> = ({ msg }) => {
  if (msg.role === 'user') {
    return (
      <div className="self-end max-w-[85%] rounded-2xl rounded-br-md bg-surface-3 px-3 py-1.5 text-[13px] leading-snug text-primary break-words">
        {msg.text}
      </div>
    )
  }
  // The agent's answer sits directly on the surface — no box — so it reads as speech.
  return (
    <div className="max-w-[94%] text-[13px] leading-relaxed text-primary break-words">
      <Markdown text={msg.text} />
    </div>
  )
}

const PlanBlock: React.FC<{ msg: ChatPlanMessage }> = ({ msg }) => (
  <div className="flex flex-col gap-1.5">
    <div className="flex items-center gap-1.5">
      <span className={LBL}>Plan</span>
    </div>
    <div className="text-[12.5px] leading-snug text-primary break-words">{msg.goal}</div>
    <div className="text-[11px] leading-snug text-muted break-words">Check: {msg.check}</div>
  </div>
)

const AttemptsBlock: React.FC<{ chat: Chat; msg: ChatAttemptsMessage; wsId: string }> = ({ chat, msg, wsId }) => {
  // Live while this is the run's active grid; else the frozen snapshot on the message.
  const live = chat.run?.attemptsMessageId === msg.id
  const iterations = (live ? chat.run?.iterations : msg.iterations) ?? []
  const recommended = live ? chat.run?.recommendedIterationId : msg.recommendedIterationId
  const iters = iterations.filter((i) => i.status !== 'cancelled')
  if (iters.length === 0) return null

  // Single attempt (the common case): the same shape as every other tool card —
  // headline + status glyph on one line, the verdict below.
  if (iters.length === 1) {
    const it = iters[0]
    const bad = it.verify && !it.verify.met
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <span className={LBL}>Loop</span>
          <IterationStatusGlyph status={it.status} />
        </div>
        <div className={`text-[12.5px] leading-snug break-words ${bad ? 'text-red-400/80' : 'text-secondary'}`}>
          {it.verify ? it.verify.reason : <span className={it.status === 'running' || it.status === 'verifying' ? 'cate-notif-pulse' : 'text-muted'}>Working</span>}
        </div>
        {it.agents.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {it.agents.map((a) => (
              <TerminalChip key={a.terminalId} wsId={wsId} panelId={a.terminalId} />
            ))}
          </div>
        )}
      </div>
    )
  }

  // Several attempts — a labelled list; each row keeps its own status.
  const passed = iters.filter((i) => i.status === 'passed').length
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className={LBL}>Loops</span>
        <span className="text-[10px] text-muted">{passed}/{iters.length} passed</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {iters.map((it, i) => (
          <IterationRow key={it.id} it={it} index={i} multi winner={recommended === it.id} wsId={wsId} />
        ))}
      </div>
    </div>
  )
}

const btn = 'flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors disabled:opacity-40'

const ResultBlock: React.FC<{ chat: Chat; msg: ChatResultMessage; wsId: string; rootPath: string; worktrees: JoinedWorktree[] }> = ({
  chat,
  msg,
  wsId,
  rootPath,
  worktrees,
}) => {
  const [busy, setBusy] = React.useState(false)
  const worktree = msg.worktreeId ? worktrees.find((w) => w.id === msg.worktreeId) : undefined
  const canLand = chat.run?.status === 'review' && !msg.outcome && !chat.run?.interrupted

  const runReview = async (fn: (w: string, r: string, c: Chat) => Promise<ReviewResult>) => {
    setBusy(true)
    try {
      await fn(wsId, rootPath, chat)
    } finally {
      setBusy(false)
    }
  }
  const confirmAndDiscard = async () => {
    const choice = await window.electronAPI?.confirmDiscardJob?.({
      hasWorktree: !!msg.worktreeId,
      terminalCount: chat.run?.terminalNodeIds?.length ?? 0,
    })
    if (choice !== 'discard') return
    await runReview(discardChat)
  }

  const outcomeLabel =
    msg.outcome === 'merged' ? 'Merged' : msg.outcome === 'pr' ? 'PR opened' : msg.outcome === 'discarded' ? 'Discarded' : null

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className={LBL}>{msg.met ? 'Result' : 'Failed'}</span>
        {msg.met ? (
          <CheckCircle size={13} weight="fill" className="flex-shrink-0 text-green-400" />
        ) : (
          <X size={13} className="flex-shrink-0 text-red-400/80" />
        )}
        {worktree && (
          <span className="ml-auto">
            <RunWorktreePill worktree={worktree} />
          </span>
        )}
      </div>
      <div className={`text-[12.5px] leading-snug break-words ${msg.met ? 'text-secondary' : 'text-red-400/80'}`}>{msg.reason}</div>
      {outcomeLabel && <div className="text-[11px] text-muted">{outcomeLabel}</div>}
      {canLand && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <button disabled={busy} onClick={() => void runReview(mergeChat)} className={`${btn} text-white bg-green-600 hover:bg-green-700`}>
            <GitMerge size={11} /> Merge
          </button>
          <button disabled={busy} onClick={() => void runReview(openPrChat)} className={`${btn} text-secondary hover:text-primary hover:bg-hover`}>
            <GitPullRequest size={11} /> PR
          </button>
          <button disabled={busy} onClick={() => void confirmAndDiscard()} className={`${btn} text-muted hover:text-red-400 hover:bg-hover`}>
            <Trash size={11} /> Discard
          </button>
        </div>
      )}
    </div>
  )
}

const CanvasBlock: React.FC<{ msg: ChatCanvasMessage; wsId: string }> = ({ msg, wsId }) => (
  <div className="flex flex-col gap-1.5">
    <div className="flex items-center gap-2">
      <SquaresFour size={13} weight="fill" className="flex-shrink-0 text-blue-400" />
      <div className={`${LBL} flex-1`}>Canvas</div>
      {msg.canvasPanelId && !msg.working && (
        <button
          onClick={() => void revealPanel(wsId, msg.canvasPanelId!, { retry: true })}
          className="text-[10px] text-blue-400 hover:text-blue-300"
        >
          Jump to canvas
        </button>
      )}
    </div>
    <div className="text-[12.5px] leading-snug text-secondary break-words">{msg.request}</div>
    {msg.working ? (
      <div className="text-[11px] cate-notif-pulse">Laying out the canvas</div>
    ) : (
      msg.panels && msg.panels.length > 0 && <div className="text-[11px] text-muted">{msg.panels.length} panel{msg.panels.length === 1 ? '' : 's'} on the canvas</div>
    )}
  </div>
)

const MessageBlock: React.FC<{ chat: Chat; msg: ChatMessage; wsId: string; rootPath: string; worktrees: JoinedWorktree[] }> = ({
  chat,
  msg,
  wsId,
  rootPath,
  worktrees,
}) => {
  switch (msg.kind) {
    case 'text':
      return <TextBlock msg={msg} />
    case 'plan':
      return <PlanBlock msg={msg} />
    case 'attempts':
      return <AttemptsBlock chat={chat} msg={msg} wsId={wsId} />
    case 'result':
      return <ResultBlock chat={chat} msg={msg} wsId={wsId} rootPath={rootPath} worktrees={worktrees} />
    case 'canvas':
      return <CanvasBlock msg={msg} wsId={wsId} />
    default:
      return null
  }
}

// --- observer timeline -------------------------------------------------------

// Relative age of a remark, coarsely (s / m / h). Recomputed on a slow tick so idle
// timestamps don't drift stale.
const relAge = (ts: number, now: number): string => {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h`
}

// The observer's remarks as a calm LOG that fills the window body like a chat: a single
// accent rail down the left, one dot + relative time per remark, newest at the bottom.
// A transient FYI — never a chat: the observer never mints a chat, it just speaks here.
// Hover a remark to dismiss it; "Clear" empties the log. When the observer is quiet the
// body explains what will show up here.
const ObserverTimeline: React.FC<{ wsId: string; items: CateAgentFeedItem[]; onRun: (prompt: string) => void }> = ({ wsId, items, onRun }) => {
  const dismissFeedItem = useCateAgentStore((s) => s.dismissFeedItem)
  const resolveFeedAction = useCateAgentStore((s) => s.resolveFeedAction)
  const clearFeed = useCateAgentStore((s) => s.clearFeed)
  const [now, setNow] = React.useState(() => Date.now())

  // A slow tick keeps the relative times fresh while the panel sits idle.
  React.useEffect(() => {
    if (items.length === 0) return
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [items.length])

  if (items.length === 0) {
    return (
      <div className="flex min-h-[96px] flex-col items-center justify-center gap-2 px-8 py-6 text-center">
        <Eye size={20} weight="bold" className="opacity-60" style={{ color: 'rgb(var(--agent-rgb))' }} />
        <span className="text-[12px] text-muted">Nothing to report yet</span>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center gap-1.5">
        <span className={LBL}>Feed</span>
        <button
          onClick={() => clearFeed(wsId)}
          title="Clear feed"
          className="ml-auto text-[10px] text-muted hover:text-primary transition-colors"
        >
          Clear
        </button>
      </div>
      <div
        className="flex flex-col gap-2.5 border-l-2 pl-4"
        style={{ borderColor: 'color-mix(in srgb, rgb(var(--agent-rgb)) 40%, transparent)' }}
      >
        {items.map((item) => (
          <div key={item.id} className="group/obs relative flex items-baseline gap-2.5">
            {/* The dot sits on the rail; a ring in the body color masks the rail behind it. */}
            <span
              aria-hidden
              className={`absolute -left-[21px] top-[6px] w-2 h-2 rounded-full ring-2 ring-surface-0 ${
                item.kind === 'error' ? 'bg-red-400' : ''
              }`}
              style={item.kind === 'error' ? undefined : { backgroundColor: 'rgb(var(--agent-rgb))' }}
            />
            <span className="flex-shrink-0 w-[30px] font-mono text-[10px] leading-snug text-muted tabular-nums">
              {relAge(item.ts, now)}
            </span>
            <div className="flex flex-1 flex-col gap-1.5 min-w-0">
              <span className={`text-[12.5px] leading-snug break-words ${FEED_KIND_CLASS[item.kind]}`}>{item.text}</span>
              {item.action &&
                (item.resolved ? (
                  // Acted on: a spent record, not a live control. It stays in the feed
                  // but can't be run again.
                  <span className="self-start flex items-center gap-1 px-2 py-0.5 rounded text-xs text-muted opacity-70">
                    {item.resolved === 'approved' ? (
                      <>
                        <Check size={11} weight="bold" /> {item.action.label}
                      </>
                    ) : (
                      <span className="line-through">{item.action.label}</span>
                    )}
                  </span>
                ) : (
                  <button
                    onClick={() => {
                      onRun(item.action!.prompt)
                      resolveFeedAction(wsId, item.id, 'approved')
                    }}
                    title={item.action.prompt}
                    className={`${btn} self-start text-white hover:brightness-110`}
                    style={{ backgroundColor: 'rgb(var(--agent-rgb))' }}
                  >
                    <Play size={10} weight="fill" /> {item.action.label}
                  </button>
                ))}
            </div>
            {/* Suggestions resolve (and stay) instead of vanishing; once resolved the X
                is gone so they can't be dismissed twice. Plain remarks still just clear. */}
            {!(item.action && item.resolved) && (
              <button
                onClick={() => (item.action ? resolveFeedAction(wsId, item.id, 'dismissed') : dismissFeedItem(wsId, item.id))}
                title="Dismiss"
                className="flex-shrink-0 -mt-[1px] p-0.5 rounded text-muted opacity-0 group-hover/obs:opacity-100 hover:text-primary hover:bg-hover transition-opacity"
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// --- run controls (Stop / Continue) ------------------------------------------

const RunControls: React.FC<{ chat: Chat; wsId: string; rootPath: string; working: boolean; activeWork: boolean }> = ({ chat, wsId, rootPath, working, activeWork }) => {
  const [busy, setBusy] = React.useState(false)
  const run = chat.run
  if (run?.interrupted) {
    const confirmAndDiscard = async () => {
      const choice = await window.electronAPI?.confirmDiscardJob?.({ hasWorktree: !!run.worktreeId, terminalCount: run.terminalNodeIds?.length ?? 0 })
      if (choice !== 'discard') return
      setBusy(true)
      try {
        await discardChat(wsId, rootPath, chat)
      } finally {
        setBusy(false)
      }
    }
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-amber-400/90 flex-1">Interrupted by a restart.</span>
        <button onClick={() => void cateAgentController.continueRun(wsId, rootPath, chat.id)} className={`${btn} text-white bg-blue-500 hover:bg-blue-600`}>
          <Play size={10} weight="fill" /> Continue
        </button>
        <button disabled={busy} onClick={() => void confirmAndDiscard()} className={`${btn} text-muted hover:text-red-400 hover:bg-hover`}>
          <Trash size={11} /> Discard
        </button>
      </div>
    )
  }
  if (run?.status === 'running') {
    return (
      <div className="flex items-center gap-1.5">
        {/* A live tool call already shimmers above; the status line then carries
            only the Stop control. In the gap it shimmers "Working" itself. */}
        {activeWork ? <span className="flex-1" /> : <span className="text-[13px] cate-notif-pulse flex-1">Working</span>}
        <button onClick={() => cateAgentController.stop(wsId, chat.id)} className={`${btn} text-secondary hover:text-red-400 hover:bg-hover`}>
          <Stop size={11} weight="fill" /> Stop
        </button>
      </div>
    )
  }
  if (working && !activeWork) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-[13px] cate-notif-pulse">Thinking</span>
      </div>
    )
  }
  return null
}

// --- empty state -------------------------------------------------------------

// A fresh chat has a tall blank body; spend it explaining the loop so a first-time
// user knows Cate runs and verifies work rather than just chatting back.
const EmptyRow: React.FC<{ icon: React.ReactNode; title: string; sub: string }> = ({ icon, title, sub }) => (
  <div className="flex items-center gap-3 py-2">
    <span className="flex-shrink-0 flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-surface-2">{icon}</span>
    <span className="flex min-w-0 flex-col leading-tight">
      <span className="text-[13px] font-medium text-primary">{title}</span>
      <span className="text-[12px] text-muted">{sub}</span>
    </span>
  </div>
)

const EmptyState: React.FC = () => (
  <div className="flex h-full flex-col items-center justify-center px-6 py-6">
    <div className="flex max-w-[320px] flex-col gap-1">
      <EmptyRow
        icon={<ArrowsSplit size={16} weight="bold" className="text-muted" />}
        title="Runs parallel loops"
        sub="each in its own worktree"
      />
      <EmptyRow
        icon={<CheckCircle size={16} className="text-muted" />}
        title="Verifies the result"
        sub="against a goal you can see"
      />
      <EmptyRow
        icon={<GitMerge size={16} className="text-muted" />}
        title="Lands the winner"
        sub="merge, open a PR, or lay out the canvas"
      />
    </div>
  </div>
)

// --- main --------------------------------------------------------------------

export const CateAgentChat: React.FC<{ workspaceId: string; rootPath: string }> = ({ workspaceId, rootPath }) => {
  const wsId = workspaceId
  const cateAgent = useCateAgentWs(wsId)
  const chats = useChatsStore((s) => s.chatsByRoot[rootPath])
  const loadChats = useChatsStore((s) => s.loadChats)
  const worktrees = useWorktrees(rootPath, wsId)

  React.useEffect(() => {
    void loadChats(rootPath)
  }, [rootPath, loadChats])

  const list = chats ?? []
  const activeChat = cateAgent.activeChatId ? list.find((c) => c.id === cateAgent.activeChatId) : undefined
  const working = cateAgent.activity === 'working' && !!activeChat && !activeChat.run

  // The shimmer rides the active work, like the agent panel. While a tool call is
  // live — a running loop iteration (one, or several in parallel) or a canvas being
  // laid out — that block shimmers, and the bottom status line drops its own
  // shimmer (just the Stop control remains). Only in the gap, when nothing is live,
  // does the status line itself shimmer ("Thinking"/"Working"). Never both at once.
  const liveIters = activeChat?.run?.status === 'running' ? (activeChat.run.iterations ?? []) : []
  const hasActiveWork =
    liveIters.some((i) => i.status === 'running' || i.status === 'verifying') ||
    (activeChat?.messages.some((m) => m.kind === 'canvas' && m.working) ?? false)

  // Run an observer suggestion: like a first message from the front door, it always
  // starts a NEW chat (titled from the prompt), which clears the observer view and
  // grows the window into that chat's transcript.
  const runPrompt = (prompt: string) => {
    const store = useChatsStore.getState()
    const chatId = store.createChat(rootPath, deriveTopic(prompt)).id
    useCateAgentStore.getState().setActiveChat(wsId, chatId)
    void cateAgentController.sendMessage(wsId, rootPath, chatId, prompt)
  }

  // Observer feed tail: the latest turn (since the last user line), capped.
  const feed = cateAgent.feed
  const lastUserIdx = feed.map((f) => f.kind).lastIndexOf('user')
  const visibleFeed = (lastUserIdx >= 0 ? feed.slice(lastUserIdx) : feed).slice(-MAX_VISIBLE_FEED)

  // The window shows the observer (the default front door) or the selected chat.
  // Which one is chosen from the picker in the toolbar bar, not a tab strip here.
  const observerView = cateAgent.observerView

  // The window is shown only while the input bar is open; it simply appears and
  // disappears with it — no open/close fade or grow animation.
  const inputOpen = cateAgent.inputOpen

  const msgCount = activeChat?.messages.length ?? 0
  // Live iteration count also grows the transcript without a new message; track it so
  // an active run stays pinned to the bottom.
  const runTick = activeChat?.run?.iterations?.length ?? 0

  // The card is only as tall as its content (each view clamps itself to a max and
  // scrolls past that). We mirror the measured content height onto the card so that
  // *switching* views (observer↔chat, chat↔chat) animates the grow/shrink. The
  // transition is armed one frame after the first measurement, so the window still
  // appears instantly at full size on open instead of growing from zero.
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const [naturalH, setNaturalH] = React.useState(0)
  const [animate, setAnimate] = React.useState(false)
  const measure = React.useCallback(() => {
    const el = contentRef.current
    if (el) setNaturalH(el.scrollHeight)
  }, [])
  // A signature of everything that changes the content's height. Measuring in a
  // layout effect keyed on this applies the new height in the SAME commit as the
  // content swap — so the grow/shrink always transitions, instead of waiting for
  // the ResizeObserver to fire a frame later (which sometimes skipped the animation).
  const contentSig = observerView
    ? 'obs:' + visibleFeed.map((f) => `${f.id}${f.resolved ?? (f.action ? 'a' : '')}`).join('|')
    : `chat:${cateAgent.activeChatId}:${msgCount}:${runTick}:${!!activeChat}`
  React.useLayoutEffect(() => {
    measure()
  }, [measure, contentSig])
  // Async settle (text wrap, images, late-loading data) that no state change captures.
  React.useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])
  React.useEffect(() => {
    if (naturalH > 0 && !animate) {
      const r = requestAnimationFrame(() => setAnimate(true))
      return () => cancelAnimationFrame(r)
    }
  }, [naturalH, animate])

  // Stick to the bottom (newest, nearest the input) as the transcript grows, unless
  // the user has scrolled up to read.
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const atBottomRef = React.useRef(true)

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }
  React.useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [msgCount, runTick, visibleFeed.length, cateAgent.activeChatId, observerView])

  if (!wsId || !inputOpen) return null

  return (
    // Same width as the toolbar bar below it: the relative parent is sized by the
    // pill, so inset-x-0 pins the card to exactly the bar's width.
    <div className="absolute bottom-full inset-x-0 mb-2">
      <div
        className="overflow-hidden rounded-2xl border border-subtle bg-surface-0 shadow-[0_8px_24px_-6px_var(--shadow-node)]"
        style={{
          height: naturalH || undefined,
          transition: animate ? 'height 240ms cubic-bezier(0.16,1,0.3,1)' : undefined,
        }}
      >
        <div ref={contentRef}>
          {observerView ? (
            // Observer: only as tall as its content needs (a floor so the empty state
            // has room, a ceiling before it scrolls).
            <div ref={scrollRef} onScroll={onScroll} className="no-scrollbar max-h-[min(420px,55vh)] overflow-y-auto">
              <ObserverTimeline wsId={wsId} items={visibleFeed} onRun={runPrompt} />
            </div>
          ) : (
            // Chat: as tall as the transcript, capped before it scrolls internally.
            <div ref={scrollRef} onScroll={onScroll} className="no-scrollbar max-h-[min(420px,55vh)] overflow-y-auto">
              {activeChat ? (
                <div className="flex flex-col gap-3.5 px-3 py-3">
                  {activeChat.messages.map((msg) => (
                    <MessageBlock key={msg.id} chat={activeChat} msg={msg} wsId={wsId} rootPath={rootPath} worktrees={worktrees} />
                  ))}
                  <RunControls chat={activeChat} wsId={wsId} rootPath={rootPath} working={working} activeWork={hasActiveWork} />
                </div>
              ) : (
                <EmptyState />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
