// Review panel state, snapshot and ops. Pure. The persisted review state
// (source filters) lives in the session file; the record carries
// only the checkout and the request it opened with. How a client shows diffs
// (split, wrap, collapsed files) is that client's own (client settings and
// client state).

import type { AgentChangedFile, AgentChangesFilter, AgentId } from '@services/agents/contract'
import type { PlaceTarget } from '@workspace/document/contract'
import type { DiffPage } from '@workspace/repository/contract'
import type { PanelCreateOptions } from '@panels/framework/contract'

/** How a client shows diffs: its `reviewSettings`. */
export interface ReviewDisplay {
  split: boolean
  wordDiff: boolean
  wrap: boolean
}

/** One checkout's review: recorded edit filters. How a reader shows
 *  it (file filter, focused file, files in full, context lines) is client
 *  state, not here. */
export interface ReviewCheckoutState {
  /** Recorded agent source filters. */
  agentChanges?: AgentChangesFilter
  repoPath: string
}

/** The session file: the current checkout's review plus the ones the panel
 *  visited before, keyed by checkout path. */
export interface ReviewState extends ReviewCheckoutState {
  worktreeStates?: Record<string, ReviewCheckoutState>
}

/** What an open request (a menu, a deep link, an agent's changes pill) asks
 *  of a review panel. */
export interface ReviewOpenRequest {
  agentChanges?: AgentChangesFilter
  /** Reveals this file once in every view (`ReviewSnapshot.reveal`). */
  focusedFile?: string
}

/** A file the runtime asked views to reveal (an open request's
 *  `focusedFile`). Views apply each `seq` once. */
export interface ReviewRevealRequest { seq: number; path: string }

/** The review's record fields. `repoPath` follows the checkout the session
 *  reviews; `request` seeds a fresh session and is ignored once it has state. */
export interface ReviewFields {
  repoPath: string
  request?: ReviewOpenRequest
}

/** One recorded file of the current selection, without its hunks (fetched
 *  with `recordedDiff`). */
export interface RecordedFileSummary {
  recordId: string
  sessionId?: string
  prNumber?: number
  agentId: AgentId
  /** Panels that showed the edit's agent session. */
  panelIds: string[]
  /** Last known titles, retained when a source panel closes. */
  panelTitles?: Record<string, string>
  path: string
  oldPath?: string
  additions: number
  deletions: number
  commit?: AgentChangedFile['commit']
  uncommitted?: boolean
  coverage: AgentChangedFile['coverage']
  lineCount: number
}

export type RecordedDiffPage = Omit<AgentChangedFile, 'patch' | 'hunks'> & DiffPage

export interface ReviewSourcePanel {
  id: string
  title: string
  agentIds: AgentId[]
}

export interface ReviewRecordedState {
  loading: boolean
  error: string | null
  files: RecordedFileSummary[]
  /** Sources across all filters, including panels that have since closed. */
  panels: ReviewSourcePanel[]
  /** Recorded contributions across all source filters. */
  agents: Array<{ agentId: AgentId; edits: number; uncommittedEdits: number }>
}

export interface ReviewSnapshot {
  /** The current checkout's review (without the other checkouts'). */
  review: ReviewCheckoutState
  recorded: ReviewRecordedState
  loading: boolean
  agentBusy: boolean
  error: string | null
  reveal: ReviewRevealRequest | null
}

export interface ReviewAgentChoice { agentId: AgentId; ready: boolean }

/** A filter patch; null clears a key (JSON has no undefined). */
export type AgentChangesFilterPatch = { [K in keyof AgentChangesFilter]?: AgentChangesFilter[K] | null }

export type ReviewOp =
  | { kind: 'refresh' }
  | { kind: 'updateFilter'; patch: AgentChangesFilterPatch }
  /** Returns one bounded `RecordedDiffPage`, without the full patch. */
  | { kind: 'recordedDiff'; recordId: string; path: string; page?: number }
  /** Returns false while a file operation runs. */
  | { kind: 'switchCheckout'; path: string; worktreeId?: string }
  /** null picks the main checkout. */
  | { kind: 'switchWorktree'; worktreeId: string | null }
  | { kind: 'retarget'; request: ReviewOpenRequest }
  /** Returns `ReviewAgentChoice[]`. */
  | { kind: 'reviewAgents' }
  /** Returns true when a reviewer started. */
  /** In `terminalPanelId`, else a new terminal at `at` (default: with the
   *  review's other agent terminals). */
  | { kind: 'reviewWithAgent'; agentId: AgentId; terminalPanelId?: string; at?: PlaceTarget }

export function defaultReviewState(repoPath: string, request?: Partial<ReviewOpenRequest>): ReviewState {
  return {
    repoPath,
    agentChanges: request?.agentChanges ?? {},
  }
}

/** The record's `repoPath`; empty means the workspace root. */
export function reviewRepoPath(fields: { [key: string]: unknown }): string {
  return typeof fields.repoPath === 'string' ? fields.repoPath : ''
}

/** A review of `repoPath`'s checkout (default: the bound worktree, else the
 *  workspace root), starting from `request`. */
export interface ReviewCreateOptions extends PanelCreateOptions {
  repoPath?: string
  request?: ReviewOpenRequest
}

/** A changed file's absolute path in the reviewed checkout. */
export function reviewFilePath(repoPath: string, relative: string): string {
  const separator = repoPath.includes('\\') && !repoPath.includes('/') ? '\\' : '/'
  return `${repoPath.replace(/[/\\]+$/, '')}${separator}${relative}`
}
