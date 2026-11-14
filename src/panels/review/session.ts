// The review panel session (architecture 11.3): recorded agent edits and
// review flows. Runs in the runtime; diffs are fetched on demand, never
// pushed in the snapshot. Persisted review state lives in the session file.

import { RpcError } from '@kernel/rpc/contract'
import {
  filterAgentChanges,
  type AgentChangeRecord,
  type AgentChangesFilter,
  type AgentChangesSnapshot,
  type AgentId,
} from '@services/agents/contract'
import type { Json, JsonObject, PanelRecord, PlaceTarget } from '@workspace/document/contract'
import {
  diffPage,
  mainWorktree,
  samePath,
  worktreeForPath,
  type RepoStatus,
} from '@workspace/repository/contract'
import { PanelSession, type OpHandlers, type SessionKit } from '@panels/framework/runtime'
import {
  defaultReviewState,
  reviewRepoPath,
  type AgentChangesFilterPatch,
  type RecordedFileSummary,
  type ReviewAgentChoice,
  type ReviewCheckoutState,
  type ReviewOp,
  type ReviewOpenRequest,
  type ReviewRevealRequest,
  type ReviewSnapshot,
  type ReviewSourcePanel,
  type ReviewState,
} from './contract'
import { recordedReviewPrompt } from './parts/runtime/prompts'

/** The git work a review needs (the repository runtime's git host and status
 *  monitors). `cwd` is an absolute checkout path. */
export interface ReviewRepository {
  /** A checkout's status: the last snapshot right away when there is one,
   *  then one per change. */
  watchStatus(cwd: string, listener: (status: RepoStatus) => void): () => void
  /** Reads a fresh status now. */
  refreshStatus(cwd: string): void
}

/** What the review needs from the agents service. */
export interface ReviewAgents {
  cachedChanges(cwd: string): AgentChangesSnapshot | undefined
  onChanges(listener: (cwd: string) => void): () => void
  /** Recorded edits in a checkout; an unchanged revision omits records. */
  readChanges(cwd: string, knownRevision?: string): Promise<AgentChangesSnapshot>
  /** Which agent CLIs can run a hook-backed review in `cwd`. */
  readiness(cwd: string): Promise<ReviewAgentChoice[]>
  /** Starts an agent in a terminal for `ownerPanelId` (placed next to it
   *  without `at`); answers with its panel. */
  start(ownerPanelId: string, args: { agentId: AgentId; prompt: string; title: string; worktreeId?: string; terminalPanelId?: string; at?: PlaceTarget }): Promise<{ panelId: string }>
}

export interface ReviewSessionDeps {
  /** Canonical workspace root: the checkout of a record without `repoPath`. */
  root: string
  repository: ReviewRepository
  agents: ReviewAgents
}

const reject = (code: string): never => { throw new RpcError('rejected', code) }

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : typeof cause === 'string' && cause ? cause : fallback
}

function checkoutView(state: ReviewState): ReviewCheckoutState {
  return {
    repoPath: state.repoPath,
    agentChanges: state.agentChanges ?? {},
  }
}

/** A new panel's review, from its record's checkout and open request. */
function freshReview(record: PanelRecord, root: string): ReviewState {
  const request = record.fields.request as unknown as ReviewOpenRequest | undefined
  return defaultReviewState(reviewRepoPath(record.fields) || root, request)
}

function initialSnapshot(review: ReviewState, reveal: ReviewRevealRequest | null): ReviewSnapshot {
  return {
    review: checkoutView(review),
    recorded: { loading: true, error: null, files: [], panels: [], agents: [] },
    loading: false,
    agentBusy: false,
    error: null,
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
  private stopStatus: (() => void) | undefined
  private statusRoot: string | undefined
  private stopChanges: (() => void) | undefined
  private records: AgentChangeRecord[] = []
  private recordsRevision: string | undefined
  private recordsFor: string | undefined
  private recordsLoading = true
  private recordsError: string | null = null
  private defaultAgentFor: string | undefined
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
      this.review = { ...checkoutView(saved), ...(saved.worktreeStates ? { worktreeStates: saved.worktreeStates } : {}) }
      // A restored panel was revealed when it opened.
      this.set({ review: checkoutView(this.review), reveal: null })
    }
    this.stopChanges = this.deps.agents.onChanges((cwd) => {
      if (samePath(cwd, this.cwd)) void this.loadRecorded()
    })
    this.observe()
  }

  // ---- State -----------------------------------------------------------------

  /** The current checkout's review. */
  current(): ReviewState { return this.review }
  private get cwd(): string { return this.review.repoPath || this.deps.root }
  private key(state: ReviewState = this.review): string {
    return state.repoPath
  }

  private write(next: ReviewState): void {
    if (this.disposed) return
    const moved = this.key(next) !== this.key()
    this.review = next
    this.persist(next as unknown as Json)
    this.set({ review: checkoutView(next) })
    if (moved) {
      this.observe()
    } else {
      this.publishRecorded()
    }
  }

  private update(patch: Partial<ReviewState>): void {
    this.write({ ...this.review, ...patch })
  }

  private async run<T>(fallback: string, action: () => Promise<T>): Promise<T | undefined> {
    this.set({ agentBusy: true, error: null })
    try {
      return await action()
    } catch (cause) {
      this.set({ error: errorText(cause, fallback) })
      return undefined
    } finally {
      this.set({ agentBusy: false })
    }
  }

  // ---- Following the checkout ------------------------------------------------

  private observe(): void {
    const root = this.cwd
    if (root !== this.statusRoot) {
      this.stopStatus?.()
      this.statusRoot = root
      this.stopStatus = this.deps.repository.watchStatus(root, () => {
        if (this.disposed || this.statusRoot !== root) return
        void this.loadRecorded()
      })
    }
    void this.loadRecorded()
  }

  async refresh(): Promise<void> {
    if (this.disposed) return
    this.set({ loading: true })
    try {
      this.deps.repository.refreshStatus(this.cwd)
      await this.loadRecorded()
    } finally {
      this.set({ loading: false })
    }
  }

  // ---- Checkouts and requests ------------------------------------------------

  private worktrees() {
    return Object.values(this.kit.document.get().worktrees)
  }

  /** Each checkout keeps its own source filters. */
  switchCheckout(target: { path: string; worktreeId?: string }): boolean {
    const state = this.review
    if (samePath(target.path, state.repoPath)) return true
    const worktreeId = target.worktreeId ?? worktreeForPath(target.path, this.worktrees())?.id
    const { worktreeStates = {}, ...current } = state
    const saved = worktreeStates[target.path] ?? defaultReviewState(target.path)
    this.write({
      ...defaultReviewState(target.path),
      ...checkoutView(saved),
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

  /** Retargets the source filters and reveals its focused file once. */
  retarget(request: ReviewOpenRequest): void {
    const current = this.review
    if (request.focusedFile) this.set({ reveal: { seq: ++this.revealSeq, path: request.focusedFile } })
    this.write({
      ...current,
      agentChanges: request.agentChanges ?? {},
    })
  }

  // ---- Recorded agent edits --------------------------------------------------

  private async loadRecorded(): Promise<void> {
    if (this.disposed) return
    const cwd = this.cwd
    if (this.recordsFor !== cwd || this.recordsLoading) {
      this.recordsFor = cwd
      const cached = this.deps.agents.cachedChanges(cwd)
      this.records = cached?.records ?? []
      this.recordsRevision = cached?.revision
      this.recordsLoading = !cached
      this.publishRecorded()
    }
    try {
      const snapshot = await this.deps.agents.readChanges(cwd, this.recordsRevision)
      if (this.disposed || this.recordsFor !== cwd) return
      if (!snapshot.records && !this.recordsLoading && !this.recordsError && !this.s.recorded.loading) return
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

  /** All retained recorded edits matching the source filters. */
  recordedSelection(): AgentChangeRecord[] {
    return filterAgentChanges(this.records, this.review.agentChanges ?? {})
  }

  private publishRecorded(): void {
    const counts = new Map<AgentId, { agentId: AgentId; edits: number; uncommittedEdits: number }>()
    for (const record of this.records) {
      const count = counts.get(record.agentId) ?? { agentId: record.agentId, edits: 0, uncommittedEdits: 0 }
      count.edits += record.files.length
      counts.set(record.agentId, count)
    }
    for (const record of this.records) counts.get(record.agentId)!.uncommittedEdits += record.files.filter((file) => file.uncommitted).length
    // Choose a useful single agent once the checkout has loaded. Prefer the
    // requested source, then active contributors, then recorded usage here.
    const filter = this.review.agentChanges ?? {}
    if (!this.recordsLoading && counts.size && (!filter.agentId || (this.defaultAgentFor !== this.cwd && !counts.has(filter.agentId)))) {
      const sourceAgents = filter.panelId ? new Set(this.records.filter((record) => record.panelIds.includes(filter.panelId!)).map((record) => record.agentId)) : null
      const preferred = [...counts.values()].sort((a, b) => Number(sourceAgents?.has(b.agentId) ?? false) - Number(sourceAgents?.has(a.agentId) ?? false) || b.uncommittedEdits - a.uncommittedEdits || b.edits - a.edits)[0]
      this.defaultAgentFor = this.cwd
      this.update({ agentChanges: { ...filter, agentId: preferred.agentId } })
      return
    }
    if (!this.recordsLoading && counts.size) this.defaultAgentFor = this.cwd
    const files: RecordedFileSummary[] = this.recordedSelection().flatMap((record) => {
      return record.files.map((file) => ({
        recordId: record.id,
        sessionId: record.sessionId,
        ...(record.prNumber ? { prNumber: record.prNumber } : {}),
        agentId: record.agentId,
        panelIds: record.panelIds,
        ...(record.panelTitles ? { panelTitles: record.panelTitles } : {}),
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
        additions: file.additions,
        deletions: file.deletions,
        coverage: file.coverage,
        ...(file.commit ? { commit: file.commit } : {}),
        uncommitted: file.uncommitted ?? false,
        lineCount: file.hunks.reduce((count, hunk) => count + hunk.lines.length, 0),
      }))
    })
    files.sort((a, b) => {
      const rank = (file: RecordedFileSummary) => file.uncommitted ? 0 : file.commit ? 1 : 2
      return rank(a) - rank(b) || (b.commit?.date ?? '').localeCompare(a.commit?.date ?? '') || (a.commit?.hash ?? '').localeCompare(b.commit?.hash ?? '')
    })
    const panels = new Map<string, ReviewSourcePanel>()
    for (const record of this.records) for (const id of record.panelIds) {
      const title = this.kit.document.get().panels[id]?.title ?? record.panelTitles?.[id] ?? `${record.agentId} · ${id.slice(0, 8)}`
      const source = panels.get(id) ?? { id, title, agentIds: [] }
      source.title = title
      if (!source.agentIds.includes(record.agentId)) source.agentIds.push(record.agentId)
      panels.set(id, source)
    }
    this.set({ recorded: { loading: this.recordsLoading, error: this.recordsError, files, panels: [...panels.values()], agents: [...counts.values()] } })
  }

  private recordedDiff(recordId: string, filePath: string, page = 0) {
    const file = this.records.find((record) => record.id === recordId)?.files.find((item) => item.path === filePath)
    if (!file) return reject('recorded-file-not-found')
    const { patch: _patch, hunks, ...summary } = file
    return { ...summary, ...diffPage(hunks, page) }
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

  /** Launches a read-only reviewer over the selected recorded edits. */
  private async reviewWithAgent(agentId: AgentId, terminalPanelId?: string, at?: PlaceTarget): Promise<boolean> {
    if (this.s.agentBusy) return false
    return await this.run('Could not start agent review', async () => {
      const prompt = recordedReviewPrompt(this.recordedSelection())
      await this.deps.agents.start(this.panelId, {
        agentId, prompt, title: 'Review changes', worktreeId: this.worktreeIdOf(this.cwd), terminalPanelId, ...(at ? { at } : {}),
      })
      return true
    }) ?? false
  }

  // ---- Ops and API -----------------------------------------------------------

  protected override readonly ops: OpHandlers<ReviewOp> = {
    refresh: () => this.refresh(),
    updateFilter: ({ patch }) => this.updateFilter(patch),
    recordedDiff: ({ recordId, path: filePath, page }) => this.recordedDiff(recordId, filePath, page),
    switchCheckout: ({ path: target, worktreeId }) => this.switchCheckout({ path: target, worktreeId }),
    switchWorktree: ({ worktreeId }) => this.switchWorktree(worktreeId),
    retarget: ({ request }) => this.retarget(request),
    reviewAgents: () => this.reviewAgents(),
    reviewWithAgent: ({ agentId, terminalPanelId, at }) => this.reviewWithAgent(agentId, terminalPanelId, at),
  }

  protected override release(): void {
    this.stopStatus?.()
    this.stopChanges?.()
  }
}
