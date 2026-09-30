// Review panel state, snapshot and ops. Pure. The persisted review state
// (comparison, notes, display, filters, collapsed files) lives in the session
// file; the record carries only the checkout and the request it opened with.

import type { AgentChangedFile, AgentChangesFilter, AgentId } from '@services/agents/contract'
import type { PlaceTarget } from '@workspace/document/contract'
import type {
  GitComparisonResult,
  GitComparisonSpec,
  GitFileDiff,
} from '@workspace/repository/contract'

export interface ReviewNote {
  id: string
  /** Recorded agent change this note belongs to; absent for Git comparisons. */
  agentChangeId?: string
  path: string
  side: 'old' | 'new' | 'file'
  line: number | null
  body: string
  context: string
  /** Stable local anchor used to relocate the note when line numbers move. */
  contextHash?: string
  resolvedBase: string | null
  resolvedTarget: string | null
  outdated?: boolean
  status?: 'open' | 'resolved'
  severity?: 'info' | 'warning' | 'error'
  author?: 'human' | 'agent'
  agentRunId?: string
  createdAt: string
}

export type ReviewNoteSeverity = NonNullable<ReviewNote['severity']>

export type ReviewNoteInput = Pick<ReviewNote, 'path' | 'side' | 'line' | 'body' | 'context' | 'severity'>
  & Partial<Pick<ReviewNote, 'agentChangeId' | 'author' | 'agentRunId' | 'resolvedBase' | 'resolvedTarget'>>

export interface ReviewDisplay {
  split: boolean
  wordDiff: boolean
  wrap: boolean
  fullFile: boolean
  advancedPreview: boolean
}

export interface ReviewSourceAgent { runId: string; ownerPanelId: string; panelId: string }

export interface ReviewAgentRun {
  runId: string
  terminalPanelId: string
  status: 'working' | 'complete' | 'failed'
  startedAt: number
  completedAt?: number
}

/** One checkout's review: comparison, filters and notes. */
export interface ReviewCheckoutState {
  /** Present only for recorded agent edits; absent means a Git comparison. */
  agentChanges?: AgentChangesFilter
  repoPath: string
  spec: GitComparisonSpec
  focusedFile?: string
  fileFilter?: string
  display: ReviewDisplay
  /** Git paths, or `${recordId}:${path}` for recorded agent edits. */
  collapsedFiles?: string[]
  /** Git comparisons: files shown in full, and per-file context line counts. */
  expandedFiles?: string[]
  contextLines?: Record<string, number>
  /** Agent changes: every recorded edit instead of only active ones. */
  showHistory?: boolean
  notes?: ReviewNote[]
  sourceAgent?: ReviewSourceAgent
  agentReview?: ReviewAgentRun
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
  spec: GitComparisonSpec
  focusedFile?: string
  sourceAgent?: ReviewSourceAgent
}

/** The review's record fields. `repoPath` follows the checkout the session
 *  reviews; `request` seeds a fresh session and is ignored once it has state. */
export interface ReviewFields {
  repoPath: string
  request?: ReviewOpenRequest
}

export type ReviewComparisonKind = GitComparisonSpec['kind'] | 'agent'

/** One recorded file of the current selection, without its hunks (fetched
 *  with `recordedDiff`). */
export interface RecordedFileSummary {
  recordId: string
  agentId: AgentId
  source: 'terminal' | 't3'
  /** Panels that showed the edit: its terminal, or chats of its thread. */
  panelIds: string[]
  path: string
  oldPath?: string
  additions: number
  deletions: number
  coverage: AgentChangedFile['coverage']
  lineCount: number
}

export interface ReviewRecordedState {
  loading: boolean
  error: string | null
  files: RecordedFileSummary[]
}

export interface ReviewSnapshot {
  /** The current checkout's review (without the other checkouts'). */
  review: ReviewCheckoutState
  /** File list and totals of the Git comparison; diffs are fetched with `diff`. */
  comparison: GitComparisonResult | null
  /** Bumps whenever loaded diffs may be stale: views refetch the ones they show. */
  diffEpoch: number
  recorded: ReviewRecordedState
  loading: boolean
  busy: boolean
  agentBusy: boolean
  error: string | null
  branches: Array<{ name: string; current: boolean; isRemote: boolean }>
  commits: Array<{ hash: string; message: string; author_name: string; date: string }>
}

export interface DiffOptions { allowLarge?: boolean; fullFile?: boolean; contextLines?: number }

export interface ReviewAgentChoice { agentId: AgentId; ready: boolean }

export type RequestChangesOutcome = 'done' | 'cancelled' | 'pick-agent'

/** A filter patch; null clears a key (JSON has no undefined). */
export type AgentChangesFilterPatch = { [K in keyof AgentChangesFilter]?: AgentChangesFilter[K] | null }

export type ReviewOp =
  | { kind: 'refresh' }
  | { kind: 'selectComparison'; comparison: ReviewComparisonKind }
  | { kind: 'setSpec'; spec: GitComparisonSpec }
  | { kind: 'update'; patch: { fileFilter?: string; showHistory?: boolean; focusedFile?: string | null } }
  | { kind: 'updateDisplay'; patch: Partial<ReviewDisplay> }
  | { kind: 'updateFilter'; patch: AgentChangesFilterPatch }
  | { kind: 'setCollapsed'; keys: string[] }
  | { kind: 'toggleCollapsed'; key: string }
  /** Returns the file's `GitFileDiff`. */
  | { kind: 'diff'; path: string; options?: DiffOptions }
  | { kind: 'expandContext'; path: string }
  | { kind: 'expandFullFile'; path: string }
  /** Returns base64 `{old, new}` bytes of an image file. */
  | { kind: 'images'; path: string; oldPath?: string }
  /** Returns the recorded `AgentChangedFile`. */
  | { kind: 'recordedDiff'; recordId: string; path: string }
  /** Returns the note. */
  | { kind: 'addNote'; note: ReviewNoteInput }
  | { kind: 'toggleNote'; noteId: string }
  | { kind: 'resolveNote'; noteId: string }
  | { kind: 'stage'; path: string }
  | { kind: 'unstage'; path: string }
  /** Destructive: the view confirms first. Untracked files go to the trash. */
  | { kind: 'discard'; path: string; untracked: boolean }
  | { kind: 'commit'; message: string }
  /** Returns `{url}` of the created pull request. */
  | { kind: 'createPullRequest' }
  /** Returns the `git apply` command for the whole comparison. */
  | { kind: 'applyCommand' }
  | { kind: 'saveNotes'; path: string }
  /** Returns false while a file operation runs. */
  | { kind: 'switchCheckout'; path: string; worktreeId?: string; branch?: string }
  /** null picks the main checkout. */
  | { kind: 'switchWorktree'; worktreeId: string | null }
  | { kind: 'retarget'; request: ReviewOpenRequest }
  /** Returns `ReviewAgentChoice[]`. */
  | { kind: 'reviewAgents' }
  /** Returns true when a reviewer started. */
  /** In `terminalPanelId`, else a new terminal at `at` (default: with the
   *  review's other agent terminals). */
  | { kind: 'reviewWithAgent'; agentId: AgentId; terminalPanelId?: string; at?: PlaceTarget }
  /** Returns a `RequestChangesOutcome`. */
  | { kind: 'requestChanges'; agentId?: AgentId; terminalPanelId?: string; at?: PlaceTarget }

export type ReviewDiffResult = GitFileDiff

export const DEFAULT_REVIEW_DISPLAY: ReviewDisplay = {
  split: false,
  wordDiff: true,
  wrap: false,
  fullFile: false,
  advancedPreview: true,
}

export function defaultReviewState(repoPath: string, request?: Partial<ReviewOpenRequest>): ReviewState {
  return {
    repoPath,
    spec: request?.spec ?? { kind: 'uncommitted' },
    ...(request?.agentChanges ? { agentChanges: request.agentChanges } : {}),
    ...(request?.focusedFile ? { focusedFile: request.focusedFile } : {}),
    ...(request?.sourceAgent ? { sourceAgent: request.sourceAgent } : {}),
    display: { ...DEFAULT_REVIEW_DISPLAY },
    collapsedFiles: [],
    notes: [],
  }
}

/** The record's `repoPath`; empty means the workspace root. */
export function reviewRepoPath(fields: { [key: string]: unknown }): string {
  return typeof fields.repoPath === 'string' ? fields.repoPath : ''
}
