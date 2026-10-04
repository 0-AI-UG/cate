// The review panel session (architecture 11.3): a Git comparison of a
// checkout or an agent's recorded edits, with notes, file actions and agent
// review flows. Runs in the runtime; diffs are fetched on demand, never
// pushed in the snapshot. Persisted review state lives in the session file.

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessionApi } from '@kernel/api/contract'
import { RpcError } from '@kernel/rpc/contract'
import {
  activeAgentChanges,
  filterAgentChanges,
  type AgentChangeRecord,
  type AgentChangesFilter,
  type AgentChangesSnapshot,
  type AgentId,
} from '@services/agents/contract'
import type { Json, JsonObject, PanelRecord, PlaceTarget } from '@workspace/document/contract'
import {
  NotARepositoryError,
  mainWorktree,
  samePath,
  worktreeForPath,
  type CreatePrResult,
  type GitBranchListResult,
  type GitComparisonResult,
  type GitComparisonSpec,
  type GitFileContent,
  type GitFileDiff,
  type GitLogEntry,
  type GitStatusResult,
  type RepoStatus,
} from '@workspace/repository/contract'
import { PanelSession, type OpHandlers, type SessionKit } from '@panels/framework/runtime'
import {
  defaultReviewState,
  notesMarkdown,
  openFindings,
  relocateNotes,
  reviewApi,
  reviewContextHash,
  reviewRepoPath,
  type AgentChangesFilterPatch,
  type DiffOptions,
  type RecordedFileSummary,
  type RequestChangesOutcome,
  type ReviewAgentChoice,
  type ReviewCheckoutState,
  type ReviewComparisonKind,
  type ReviewNote,
  type ReviewNoteInput,
  type ReviewOp,
  type ReviewOpenRequest,
  type ReviewRevealRequest,
  type ReviewSnapshot,
  type ReviewState,
} from './contract'
import { changesAgentPrompt, recordedReviewPrompt, reviewAgentPrompt } from './parts/prompts'

/** The git work a review needs (the repository runtime's git host and status
 *  monitors). `cwd` is an absolute checkout path. */
export interface ReviewRepository {
  compare(params: { cwd: string; spec: GitComparisonSpec }): Promise<GitComparisonResult>
  fileDiff(params: { cwd: string; spec: GitComparisonSpec; path: string; contextLines?: number; allowLarge?: boolean }): Promise<GitFileDiff>
  fileContent(params: { cwd: string; spec: GitComparisonSpec; path: string; side: 'old' | 'new' }): Promise<GitFileContent>
  stage(params: { cwd: string; path: string }): Promise<void>
  unstage(params: { cwd: string; path: string }): Promise<void>
  discardFile(params: { cwd: string; path: string }): Promise<void>
  commit(params: { cwd: string; message: string }): Promise<void>
  log(params: { cwd: string; maxCount?: number }): Promise<GitLogEntry[]>
  branchList(params: { cwd: string }): Promise<GitBranchListResult>
  readStatus(params: { cwd: string }): Promise<GitStatusResult>
  createPr(params: { path: string; branch: string }): Promise<CreatePrResult>
  /** A checkout's status: the last snapshot right away when there is one,
   *  then one per change. */
  watchStatus(cwd: string, listener: (status: RepoStatus) => void): () => void
  /** Reads a fresh status now. */
  refreshStatus(cwd: string): void
}

export interface ReviewFiles {
  /** Moves a file to the trash (deletes it where there is none). */
  trash(absolutePath: string): Promise<void>
  writeText(absolutePath: string, text: string): Promise<void>
}

/** A mission run owned by a panel. */
export interface ReviewAgentRunInfo {
  id: string
  /** The terminal the run works in. */
  panelId: string
  createdAt: number
  endedAt?: number
}

/** What the review needs from the agents service. */
export interface ReviewAgents {
  /** Recorded edits in a checkout; an unchanged revision omits records. */
  readChanges(cwd: string, knownRevision?: string): Promise<AgentChangesSnapshot>
  /** Which agent CLIs can run a hook-backed review in `cwd`. */
  readiness(cwd: string): Promise<ReviewAgentChoice[]>
  /** Starts a mission worker owned by `ownerPanelId`. */
  startRun(ownerPanelId: string, args: { agentId: AgentId; prompt: string; title: string; worktreeId?: string; terminalPanelId?: string; at?: PlaceTarget }): Promise<{ id: string; panelId: string }>
  /** Sends a follow-up prompt to a run; rejects when its session is gone. */
  sendToRun(ownerPanelId: string, runId: string, prompt: string): Promise<void>
  runs(ownerPanelId: string): Promise<ReviewAgentRunInfo[]>
  onRunsChanged(listener: () => void): () => void
  /** The T3 thread a chat panel shows. */
  threadIdOf(panelId: string): string | undefined
}

export interface ReviewSessionDeps {
  /** Canonical workspace root: the checkout of a record without `repoPath`. */
  root: string
  repository: ReviewRepository
  files: ReviewFiles
  agents: ReviewAgents
}

const reject = (code: string): never => { throw new RpcError('rejected', code) }

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : typeof cause === 'string' && cause ? cause : fallback
}

const MAX_LOADS = 4

function checkoutView(state: ReviewState): ReviewCheckoutState {
  const { worktreeStates: _others, ...current } = state
  return current
}

/** A new panel's review, from its record's checkout and open request. */
function freshReview(record: PanelRecord, root: string): ReviewState {
  const request = record.fields.request as unknown as ReviewOpenRequest | undefined
  return defaultReviewState(reviewRepoPath(record.fields) || root, request)
}

function initialSnapshot(review: ReviewState, reveal: ReviewRevealRequest | null): ReviewSnapshot {
  return {
    review: checkoutView(review),
    comparison: null,
    diffEpoch: 0,
    recorded: { loading: true, error: null, files: [] },
    loading: false,
    busy: false,
    agentBusy: false,
    error: null,
    notRepository: false,
    branches: [],
    commits: [],
    reveal,
  }
}

/** A new panel's open request reveals its file once. */
function requestReveal(record: PanelRecord): ReviewRevealRequest | null {
  const request = record.fields.request as unknown as ReviewOpenRequest | undefined
  return request?.focusedFile ? { seq: 1, path: request.focusedFile } : null
}

export class ReviewSession extends PanelSession<JsonObject, ReviewOp> {
  private review: ReviewState
  private status: RepoStatus | null = null
  private stopStatus: (() => void) | undefined
  private statusRoot: string | undefined
  private stopRuns: (() => void) | undefined
  private records: AgentChangeRecord[] = []
  private recordsRevision: string | undefined
  private recordsFor: string | undefined
  private recordsLoading = true
  private recordsError: string | null = null
  private comparisonKey = ''
  private generation = 0
  private activeLoads = 0
  private queue: Array<{ run(): void; reject(error: Error): void }> = []
  private revealSeq = 1

  constructor(kit: SessionKit, record: PanelRecord, private readonly deps: ReviewSessionDeps) {
    super(kit, record, initialSnapshot(freshReview(record, deps.root), requestReveal(record)) as unknown as JsonObject)
    this.review = freshReview(record, deps.root)
  }

  /** Typed view of the snapshot. */
  private get s(): ReviewSnapshot { return this.state as unknown as ReviewSnapshot }
  private set(patch: Partial<ReviewSnapshot>): void { this.publish(patch as unknown as Partial<JsonObject>) }

  override start(): void {
    const saved = this.persisted<ReviewState & Json>()
    if (saved && typeof saved === 'object' && typeof saved.repoPath === 'string') {
      this.review = { ...defaultReviewState(saved.repoPath), ...saved }
      // A restored panel was revealed when it opened.
      this.set({ review: checkoutView(this.review), reveal: null })
    }
    this.stopRuns = this.deps.agents.onRunsChanged(() => void this.checkAgentReview())
    void this.checkAgentReview()
    this.observe()
  }

  // ---- State -----------------------------------------------------------------

  /** The current checkout's review. */
  current(): ReviewState { return this.review }
  private get cwd(): string { return this.review.repoPath || this.deps.root }
  private key(state: ReviewState = this.review): string {
    return JSON.stringify([state.repoPath, state.spec, !!state.agentChanges])
  }

  private write(next: ReviewState): void {
    if (this.disposed) return
    const moved = this.key(next) !== this.key()
    this.review = next
    this.persist(next as unknown as Json)
    this.set({ review: checkoutView(next) })
    if (moved) {
      this.generation++
      this.observe()
    } else if (next.agentChanges) {
      this.publishRecorded()
    }
  }

  private update(patch: Partial<ReviewState>): void {
    this.write({ ...this.review, ...patch })
  }

  private async run<T>(flag: 'busy' | 'agentBusy', fallback: string, action: () => Promise<T>): Promise<T | undefined> {
    this.set({ [flag]: true, error: null })
    try {
      return await action()
    } catch (cause) {
      this.set({ error: errorText(cause, fallback) })
      return undefined
    } finally {
      this.set({ [flag]: false })
    }
  }

  // ---- Following the checkout ------------------------------------------------

  private observe(): void {
    const root = this.cwd
    if (root !== this.statusRoot) {
      this.stopStatus?.()
      this.statusRoot = root
      this.status = null
      this.stopStatus = this.deps.repository.watchStatus(root, (status) => {
        if (this.disposed || this.statusRoot !== root) return
        this.status = status
        if (this.review.agentChanges) {
          this.publishRecorded()
          void this.loadRecorded()
        } else {
          void this.refresh()
        }
        void this.loadReferences()
      })
    }
    if (this.review.agentChanges) {
      void this.loadRecorded()
    } else {
      void this.refresh()
      void this.loadReferences()
    }
  }

  protected override recordChanged(previous: PanelRecord): void {
    const next = reviewRepoPath(this.record.fields)
    if (next && next !== reviewRepoPath(previous.fields) && next !== this.review.repoPath) this.switchCheckout({ path: next })
  }

  // ---- Git comparison --------------------------------------------------------

  async refresh(): Promise<void> {
    if (this.disposed) return
    const state = this.review
    if (state.agentChanges) {
      this.set({ loading: true })
      try {
        this.deps.repository.refreshStatus(this.cwd)
        await this.loadRecorded()
      } finally {
        this.set({ loading: false })
      }
      return
    }
    const generation = ++this.generation
    const key = JSON.stringify([state.repoPath, state.spec])
    const previousKey = this.comparisonKey
    this.comparisonKey = key
    const changed = key !== previousKey
    if (changed) this.set({ comparison: null })
    this.set({ loading: true, error: null })
    try {
      const result = await this.deps.repository.compare({ cwd: this.cwd, spec: state.spec })
      if (this.disposed || generation !== this.generation) return
      const paths = new Set(result.files.map((file) => file.path))
      this.set({ comparison: result, diffEpoch: this.s.diffEpoch + 1, notRepository: false })
      const notes = (this.review.notes ?? []).map((note) => ({ ...note, outdated: !paths.has(note.path) }))
      if (notes.some((note, index) => note.outdated !== this.review.notes?.[index]?.outdated)) this.update({ notes })
    } catch (cause) {
      if (generation !== this.generation) return
      if (cause instanceof NotARepositoryError) this.set({ notRepository: true })
      else this.set({ error: errorText(cause, 'Could not load comparison') })
    } finally {
      if (generation === this.generation) this.set({ loading: false })
    }
  }

  private async loadReferences(): Promise<void> {
    const repoPath = this.review.repoPath
    if (this.review.agentChanges) return
    try {
      const [branches, commits] = await Promise.all([
        this.deps.repository.branchList({ cwd: this.cwd }),
        this.deps.repository.log({ cwd: this.cwd, maxCount: 100 }),
      ])
      if (this.disposed || this.review.repoPath !== repoPath) return
      this.set({
        branches: branches.branches.map(({ name, current, isRemote }) => ({ name, current, isRemote })),
        commits: commits.map(({ hash, message, author_name, date }) => ({ hash, message, author_name, date })),
      })
    } catch {
      // The comparison stays usable without reference suggestions.
    }
  }

  /** The live comparison; rejects when the checkout or spec changed meanwhile.
   *  Status refreshes of the same comparison are fine. */
  async inspect(): Promise<GitComparisonResult> {
    const state = this.review
    const key = JSON.stringify([state.repoPath, state.spec])
    const comparison = await this.deps.repository.compare({ cwd: this.cwd, spec: state.spec })
    if (this.disposed || key !== JSON.stringify([this.review.repoPath, this.review.spec])) reject('review-changed')
    return comparison
  }

  private limited<T>(factory: () => Promise<T>): Promise<T> {
    return new Promise((resolve, fail) => {
      if (this.disposed) { fail(new RpcError('gone', 'Review closed')); return }
      this.queue.push({
        reject: fail,
        run: () => {
          Promise.resolve().then(factory).then(resolve, fail).finally(() => { this.activeLoads--; this.pump() })
        },
      })
      this.pump()
    })
  }

  private pump(): void {
    while (!this.disposed && this.activeLoads < MAX_LOADS && this.queue.length) {
      this.activeLoads++
      this.queue.shift()!.run()
    }
  }

  /** Loads a file's diff as the asking client shows it (`options`); line
   *  notes of the file follow it. */
  async diff(filePath: string, options: DiffOptions = {}): Promise<GitFileDiff> {
    const state = this.review
    const generation = this.generation
    const contextLines = options.allLines || options.fullFile ? 999_999 : options.contextLines ?? 3
    const diff = await this.limited(() => this.deps.repository.fileDiff({
      cwd: this.cwd,
      spec: state.spec,
      path: filePath,
      contextLines,
      allowLarge: options.allowLarge || !!options.fullFile,
    }))
    if (!this.disposed && generation === this.generation) {
      const notes = relocateNotes(this.review.notes ?? [], filePath, diff.hunks)
      if (notes) this.update({ notes })
    }
    return diff
  }

  private async images(filePath: string, oldPath?: string): Promise<{ old: string | null; new: string | null }> {
    const { spec } = this.review
    const [before, after] = await Promise.all([
      this.limited(() => this.deps.repository.fileContent({ cwd: this.cwd, spec, path: oldPath ?? filePath, side: 'old' })),
      this.limited(() => this.deps.repository.fileContent({ cwd: this.cwd, spec, path: filePath, side: 'new' })),
    ])
    return { old: before.base64 ?? null, new: after.base64 ?? null }
  }

  private selectComparison(kind: ReviewComparisonKind): Promise<unknown> {
    return this.run('busy', 'Could not change comparison', async () => {
      const state = this.review
      let spec = state.spec
      const ignoreWhitespace = spec.ignoreWhitespace
      if (kind === 'commit') {
        const commits = await this.deps.repository.log({ cwd: this.cwd, maxCount: 1 })
        if (!commits[0]) throw new Error('This repository has no commits yet.')
        spec = { kind, commit: commits[0].hash, ignoreWhitespace }
      } else if (kind === 'branch') {
        const [result, status] = await Promise.all([
          this.deps.repository.branchList({ cwd: this.cwd }),
          this.deps.repository.readStatus({ cwd: this.cwd }),
        ])
        const branches = result.branches
        const current = branches.find((b) => b.current)?.name ?? branches.find((b) => !b.isRemote)?.name
        const base = branches.find((b) => b.name === status.tracking || b.name === `remotes/${status.tracking}`)?.name
          ?? branches.find((b) => b.name === 'main')?.name ?? branches.find((b) => b.name === 'master')?.name
          ?? branches.find((b) => b.name !== current)?.name ?? current
        if (!current || !base) throw new Error('This repository has no branches yet.')
        spec = { kind, base, target: current, ignoreWhitespace }
      } else if (kind !== 'agent') {
        spec = { kind, ignoreWhitespace }
      }
      if (this.review.repoPath !== state.repoPath) return
      const agentChanges = kind === 'agent' ? this.review.agentChanges ?? {} : undefined
      this.write({ ...this.review, spec, agentChanges })
    })
  }

  // ---- File actions ----------------------------------------------------------

  /** A git change; a failure shows in the snapshot and also fails the op, so
   *  a caller never takes an unstaged file for staged. */
  private async mutate(fallback: string, action: () => Promise<unknown>): Promise<void> {
    let failure: unknown
    await this.run('busy', fallback, async () => {
      try {
        await action()
      } catch (cause) {
        failure = cause
        throw cause
      }
      this.deps.repository.refreshStatus(this.cwd)
      await this.refresh()
    })
    if (failure !== undefined) throw new RpcError('rejected', errorText(failure, fallback))
  }

  private absolute(relativePath: string): string {
    return path.join(this.cwd, relativePath)
  }

  private async applyCommand(): Promise<string> {
    const comparison = this.s.comparison
    if (!comparison) return reject('no-comparison')
    const { spec } = this.review
    const patches = await Promise.all(comparison.files.map((file) => this.limited(() =>
      this.deps.repository.fileDiff({ cwd: this.cwd, spec, path: file.path, contextLines: 3, allowLarge: true }))))
    const incomplete = patches.find((item) => item.patch == null)
    if (incomplete) throw new RpcError('rejected', `A complete patch cannot be created for ${incomplete.path}`)
    const marker = 'CATE_DIFF_PATCH'
    return `git apply <<'${marker}'\n${patches.map((item) => item.patch).filter(Boolean).join('\n')}\n${marker}`
  }

  private async createPullRequest(): Promise<{ url: string } | null> {
    const url = await this.run('busy', 'Could not create pull request', async () => {
      const branch = this.s.comparison?.currentBranch
      if (!branch) return null
      const result = await this.deps.repository.createPr({ path: this.cwd, branch })
      if (!result.ok) throw new Error(result.message)
      return result.url
    })
    return url ? { url } : null
  }

  // ---- Notes -----------------------------------------------------------------

  addNote(input: ReviewNoteInput): ReviewNote {
    const comparison = this.review.agentChanges ? null : this.s.comparison
    const note: ReviewNote = {
      resolvedBase: comparison?.resolvedBase ?? null,
      resolvedTarget: comparison?.resolvedTarget ?? null,
      author: 'human',
      ...input,
      id: randomUUID(),
      contextHash: reviewContextHash(input.context),
      status: 'open',
      createdAt: new Date().toISOString(),
    }
    this.update({ notes: [...(this.review.notes ?? []), note] })
    return note
  }

  /** Anchors a note to a line of the live comparison. */
  async addLineNote(input: Omit<ReviewNoteInput, 'context' | 'side' | 'line'> & { side: 'old' | 'new'; line: number }): Promise<ReviewNote> {
    const key = JSON.stringify([this.review.repoPath, this.review.spec])
    const { spec } = this.review
    const comparison = await this.inspect()
    if (!comparison.files.some((file) => file.path === input.path)) reject('file-not-in-review')
    const diff = await this.limited(() => this.deps.repository.fileDiff({ cwd: this.cwd, spec, path: input.path, contextLines: 3, allowLarge: true }))
    const matching = diff.hunks.flatMap((hunk) => hunk.lines).find((line) => (input.side === 'old' ? line.oldLine : line.newLine) === input.line)
    if (!matching) return reject('line-not-in-diff')
    if (JSON.stringify([this.review.repoPath, this.review.spec]) !== key) reject('review-changed')
    return this.addNote({ ...input, context: matching.text, resolvedBase: comparison.resolvedBase, resolvedTarget: comparison.resolvedTarget })
  }

  private setNoteStatus(noteId: string, status: (note: ReviewNote) => ReviewNote['status']): void {
    this.update({ notes: (this.review.notes ?? []).map((note) => (note.id === noteId ? { ...note, status: status(note) } : note)) })
  }

  /** Resolves by id or unique id prefix. */
  resolveNote(prefix: string): string {
    const matches = (this.review.notes ?? []).filter((note) => note.id === prefix || note.id.startsWith(prefix))
    if (matches.length === 0) reject('review-note-not-found')
    if (matches.length > 1) reject('ambiguous-review-note')
    this.setNoteStatus(matches[0].id, () => 'resolved')
    return matches[0].id
  }

  // ---- Checkouts and requests ------------------------------------------------

  private worktrees() {
    return Object.values(this.kit.document.get().worktrees)
  }

  /** Each checkout keeps its own comparison and notes. False while a file
   *  operation runs. */
  switchCheckout(target: { path: string; worktreeId?: string; branch?: string }): boolean {
    const state = this.review
    if (samePath(target.path, state.repoPath)) return true
    if (this.s.busy) return false
    const worktreeId = target.worktreeId ?? worktreeForPath(target.path, this.worktrees())?.id
    const { worktreeStates = {}, ...current } = state
    const spec: GitComparisonSpec = state.spec.kind === 'branch' ? { ...state.spec, target: target.branch || 'HEAD' } : state.spec
    const saved = worktreeStates[target.path] ?? { repoPath: target.path, spec, agentChanges: state.agentChanges ? {} : undefined }
    this.write({
      ...defaultReviewState(target.path),
      ...saved,
      worktreeStates: { ...worktreeStates, [state.repoPath]: current },
    })
    try {
      this.kit.document.apply({ kind: 'updatePanel', id: this.panelId, patch: { worktreeId: worktreeId ?? null, fields: { repoPath: target.path } } })
    } catch (cause) {
      this.kit.log.warn('review %s could not follow its checkout in the record: %s', this.panelId, errorText(cause, 'failed'))
    }
    return true
  }

  private switchWorktree(worktreeId: string | null): boolean {
    const worktrees = this.worktrees()
    const target = worktreeId === null ? mainWorktree(worktrees, this.deps.root) : worktrees.find((tree) => tree.id === worktreeId)
    if (target) return this.switchCheckout({ path: target.path, worktreeId: target.id })
    if (worktreeId === null) return this.switchCheckout({ path: this.deps.root })
    return reject('worktree-not-found')
  }

  /** Merges an open request: a new source agent restarts its review. Views
   *  reveal its focused file once. */
  retarget(request: ReviewOpenRequest): void {
    const current = this.review
    if (request.focusedFile) this.set({ reveal: { seq: ++this.revealSeq, path: request.focusedFile } })
    this.write({
      ...current,
      spec: request.spec,
      sourceAgent: request.sourceAgent,
      agentChanges: request.agentChanges,
      agentReview: request.sourceAgent?.runId !== current.sourceAgent?.runId ? undefined : current.agentReview,
    })
  }

  // ---- Recorded agent edits --------------------------------------------------

  private async loadRecorded(): Promise<void> {
    const cwd = this.cwd
    if (this.recordsFor !== cwd) {
      this.recordsFor = cwd
      this.records = []
      this.recordsRevision = undefined
      this.recordsLoading = true
      this.publishRecorded()
    }
    try {
      const snapshot = await this.deps.agents.readChanges(cwd, this.recordsRevision)
      if (this.disposed || this.recordsFor !== cwd) return
      if (snapshot.records) this.records = snapshot.records
      this.recordsRevision = snapshot.revision
      this.recordsError = null
    } catch (cause) {
      if (this.recordsFor === cwd) this.recordsError = errorText(cause, 'Could not load recorded changes')
    }
    if (this.recordsFor !== cwd) return
    this.recordsLoading = false
    this.publishRecorded()
  }

  /** Recorded edits matching the panel's filters: active ones (still changed
   *  in Git) unless history is shown. A reader's file filter is the view's. */
  recordedSelection(): AgentChangeRecord[] {
    const state = this.review
    const filter = state.agentChanges ?? {}
    const thread = filter.panelId ? this.deps.agents.threadIdOf(filter.panelId) : undefined
    const status = this.status
    const pool = state.showHistory
      ? this.records
      : status ? activeAgentChanges(this.records, { isRepo: status.isRepo, statusFiles: status.files }) : []
    return filterAgentChanges(pool, filter, thread)
  }

  private publishRecorded(): void {
    if (!this.review.agentChanges) return
    const panels = Object.keys(this.kit.document.get().panels)
    const threadPanels = new Map<string, string[]>()
    for (const id of panels) {
      const thread = this.deps.agents.threadIdOf(id)
      if (thread) threadPanels.set(thread, [...(threadPanels.get(thread) ?? []), id])
    }
    const files: RecordedFileSummary[] = this.recordedSelection().flatMap((record) => {
      const panelIds = record.source === 'terminal'
        ? (record.panelId ? [record.panelId] : [])
        : [...new Set([...(record.panelIds ?? []), ...(threadPanels.get(record.sourceId) ?? [])])]
      return record.files.map((file) => ({
        recordId: record.id,
        agentId: record.agentId,
        source: record.source,
        panelIds,
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
        additions: file.additions,
        deletions: file.deletions,
        coverage: file.coverage,
        lineCount: file.hunks.reduce((count, hunk) => count + hunk.lines.length, 0),
      }))
    })
    this.set({ recorded: { loading: this.recordsLoading || this.status === null, error: this.recordsError, files } })
  }

  private recordedDiff(recordId: string, filePath: string) {
    const file = this.records.find((record) => record.id === recordId)?.files.find((item) => item.path === filePath)
    return file ?? reject('recorded-file-not-found')
  }

  private updateFilter(patch: AgentChangesFilterPatch): void {
    const next: Record<string, unknown> = { ...this.review.agentChanges }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined || value === '') delete next[key]
      else next[key] = value
    }
    this.update({ agentChanges: next as AgentChangesFilter })
  }

  // ---- Agent review flows ----------------------------------------------------

  private worktreeIdOf(checkout: string): string | undefined {
    return worktreeForPath(checkout, this.worktrees())?.id
  }

  private async reviewAgents(): Promise<ReviewAgentChoice[]> {
    try {
      return await this.deps.agents.readiness(this.cwd)
    } catch (cause) {
      this.set({ error: errorText(cause, 'Could not inspect available agents') })
      return []
    }
  }

  /** Launches a read-only reviewer over the Git comparison or the selected
   *  recorded edits. */
  private async reviewWithAgent(agentId: AgentId, terminalPanelId?: string, at?: PlaceTarget): Promise<boolean> {
    if (this.s.agentBusy || this.review.agentReview?.status === 'working') return false
    return await this.run('agentBusy', 'Could not start agent review', async () => {
      const state = this.review
      const prompt = state.agentChanges
        ? recordedReviewPrompt(this.recordedSelection(), this.panelId)
        : reviewAgentPrompt(this.panelId, this.cwd, state.spec)
      const run = await this.deps.agents.startRun(this.panelId, {
        agentId, prompt, title: 'Review changes', worktreeId: this.worktreeIdOf(this.cwd), terminalPanelId, ...(at ? { at } : {}),
      })
      this.update({ agentReview: { runId: run.id, terminalPanelId: run.panelId, status: 'working', startedAt: Date.now() } })
      return true
    }) ?? false
  }

  /** Sends open findings to the source agent, or to a new agent when
   *  `agentId` is given. 'pick-agent' when the source session is gone. */
  private async requestChanges(agentId?: AgentId, terminalPanelId?: string, at?: PlaceTarget): Promise<RequestChangesOutcome> {
    return await this.run('agentBusy', 'Could not request changes', async (): Promise<RequestChangesOutcome> => {
      const state = this.review
      const notes = openFindings(state.notes)
      if (notes.length === 0) return 'cancelled'
      const prompt = changesAgentPrompt(this.panelId, notes)
      if (!agentId && state.sourceAgent) {
        try {
          await this.deps.agents.sendToRun(state.sourceAgent.ownerPanelId, state.sourceAgent.runId, prompt)
          return 'done'
        } catch {
          this.set({ error: 'The original agent session is no longer available. Choose an agent to start a new session.' })
          return 'pick-agent'
        }
      }
      if (!agentId) return 'cancelled'
      await this.deps.agents.startRun(this.panelId, {
        agentId, prompt, title: 'Address review findings', worktreeId: this.worktreeIdOf(this.cwd), terminalPanelId, ...(at ? { at } : {}),
      })
      return 'done'
    }) ?? 'cancelled'
  }

  /** A reviewer whose run ended without `cate review complete` failed. */
  private async checkAgentReview(): Promise<void> {
    const review = this.review.agentReview
    if (review?.status !== 'working') return
    const run = (await this.deps.agents.runs(this.panelId)).find((item) => item.id === review.runId)
    const latest = this.review.agentReview
    if (this.disposed || latest?.runId !== review.runId || latest.status !== 'working') return
    if (run?.endedAt) this.update({ agentReview: { ...latest, status: 'failed', completedAt: run.endedAt } })
  }

  private async callerRun(callerPanelId: string | undefined): Promise<ReviewAgentRunInfo | undefined> {
    if (!callerPanelId) return undefined
    const runs = (await this.deps.agents.runs(this.panelId)).filter((run) => run.panelId === callerPanelId)
    return runs.sort((a, b) => b.createdAt - a.createdAt)[0]
  }

  /** Only the reviewer run assigned to this panel may complete it. */
  async completeAgentReview(callerPanelId: string | undefined): Promise<void> {
    const assigned = this.review.agentReview
    const run = await this.callerRun(callerPanelId)
    if (!run || (assigned && (assigned.terminalPanelId !== callerPanelId || assigned.runId !== run.id))) reject('review-agent-mismatch')
    this.update({
      agentReview: {
        runId: run!.id,
        terminalPanelId: run!.panelId,
        startedAt: assigned?.startedAt ?? run!.createdAt,
        status: 'complete',
        completedAt: Date.now(),
      },
    })
  }

  // ---- Ops and API -----------------------------------------------------------

  protected override readonly ops: OpHandlers<ReviewOp> = {
    refresh: () => this.refresh(),
    selectComparison: ({ comparison }) => this.selectComparison(comparison),
    setSpec: ({ spec }) => { this.update({ spec }) },
    update: ({ patch }) => {
      if (patch.showHistory !== undefined) this.update({ showHistory: patch.showHistory })
    },
    updateFilter: ({ patch }) => this.updateFilter(patch),
    diff: ({ path: filePath, options }) => this.diff(filePath, options),
    images: ({ path: filePath, oldPath }) => this.images(filePath, oldPath),
    recordedDiff: ({ recordId, path: filePath }) => this.recordedDiff(recordId, filePath),
    addNote: ({ note }) => this.addNote(note),
    toggleNote: ({ noteId }) => this.setNoteStatus(noteId, (note) => (note.status === 'resolved' ? 'open' : 'resolved')),
    resolveNote: ({ noteId }) => this.resolveNote(noteId),
    stage: ({ path: filePath }) => this.mutate('Could not update file', () => this.deps.repository.stage({ cwd: this.cwd, path: filePath })),
    unstage: ({ path: filePath }) => this.mutate('Could not update file', () => this.deps.repository.unstage({ cwd: this.cwd, path: filePath })),
    discard: ({ path: filePath, untracked }) => this.mutate('Could not update file', () => (untracked
      ? this.deps.files.trash(this.absolute(filePath))
      : this.deps.repository.discardFile({ cwd: this.cwd, path: filePath }))),
    commit: ({ message }) => this.mutate('Could not commit', () => this.deps.repository.commit({ cwd: this.cwd, message })),
    createPullRequest: () => this.createPullRequest(),
    applyCommand: () => this.applyCommand(),
    saveNotes: ({ path: target }) => this.deps.files.writeText(target, notesMarkdown(this.review.notes ?? [])),
    switchCheckout: ({ path: target, worktreeId, branch }) => this.switchCheckout({ path: target, worktreeId, branch }),
    switchWorktree: ({ worktreeId }) => this.switchWorktree(worktreeId),
    retarget: ({ request }) => this.retarget(request),
    reviewAgents: () => this.reviewAgents(),
    reviewWithAgent: ({ agentId, terminalPanelId, at }) => this.reviewWithAgent(agentId, terminalPanelId, at),
    requestChanges: ({ agentId, terminalPanelId, at }) => this.requestChanges(agentId, terminalPanelId, at),
  }

  override handleApi = sessionApi(reviewApi, {
    inspect: async () => {
      const state = this.review
      const comparison = await this.inspect()
      return {
        panelId: this.panelId,
        repoPath: this.cwd,
        spec: state.spec,
        resolvedBase: comparison.resolvedBase,
        resolvedTarget: comparison.resolvedTarget,
        files: comparison.files,
        notes: this.review.notes ?? [],
      }
    },
    'note.add': async ({ file, line, side, body, severity }, ctx) => {
      const text = body.trim()
      if (!text) reject('body-required')
      const run = await this.callerRun(ctx.caller.panelId)
      return this.addLineNote({ path: file, side, line, body: text, severity, author: 'agent', agentRunId: run?.id })
    },
    'note.resolve': ({ noteId }) => ({ noteId: this.resolveNote(noteId), status: 'resolved' }),
    complete: async (_args, ctx) => {
      await this.completeAgentReview(ctx.caller.panelId)
      return { status: 'complete' }
    },
  })

  protected override release(): void {
    this.stopStatus?.()
    this.stopRuns?.()
    for (const task of this.queue.splice(0)) task.reject(new RpcError('gone', 'Review closed'))
  }
}
