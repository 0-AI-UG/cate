// =============================================================================
// cateAgentController — the Cate Agent's brain (renderer, main window).
//
// Owns the headless sessions and their loops:
//   - Observer: an always-on session per enabled workspace. A 60s tick consults
//     the trigger gate; when it passes the observer takes ONE turn and may
//     propose_todo. Proposals land as `suggested` todos for the user to approve.
//   - Orchestrator (the `orchestrator` role): an ephemeral session per todo. It runs
//     a code job as a LOOP — set a goal + check, spawn parallel ITERATIONS (each its
//     own fresh worktree + a per-iteration driver), pick a winner or run another
//     round. It never chooses agents and never edits files itself. Read-only jobs
//     settle via answer.
//   - Iteration check: when an iteration's work driver settles (its iteration flips to
//     `finished`), the controller runs the check through an independent VERIFIER
//     driver in its worktree (runIterationCheck) that writes a verdict. The controller
//     records the verdict and wakes the orchestrator with it.
//
// The orchestrator is event-driven: its tool calls only mutate todo/iteration
// state, then it ends its turn. The controller reconciles that state on each yield
// — running checks, waiting on iterations to settle, and waking the orchestrator
// when something it cares about completes.
//
// State here is per-workspace and not persisted beyond the enabled + autoObserve
// flags (.cate/cateAgent.json); in-flight runs are NOT resumed after a restart —
// restore() reconciles their orphaned in_progress todos.
// =============================================================================

import type { Todo, CateAgentActivity } from '../../shared/types'
import type { CateAgentBridgeHost, CateAgentContext } from './cateAgentTypes'
import { setCateAgentBridgeHost } from './cateAgentBridge'
import {
  observerPanelId,
  orchestratorPanelId,
  createCateAgentSession,
  promptCateAgent,
  disposeCateAgent,
} from './cateAgentSession'
import { shouldObserve } from './cateAgentTriggerGate'
import { setContext, getContext, deleteContext, hasContext, contextPanelIds } from './cateAgentContextRegistry'
import { signalRunEnd } from './cateAgentRunWaiters'
import {
  buildObserveContext,
  buildOrchestratorContext,
  waitForIterationsSettled,
  patchIteration,
  runIterationCheck,
  deriveTopic,
} from './cateAgentTools'
import { teardownTodoWork } from './cateAgentReviewActions'
import { useCateAgentStore } from './cateAgentStore'
import { useTodosStore } from '../stores/todosStore'
import { generateId } from '../stores/canvas/helpers'
import { workspaceIdForTerminal } from '../stores/statusStore'
import { gitStatusStore } from '../stores/gitStatusStore'
import log from '../lib/logger'

/** Per-run orchestrator state (stall/wake bounding). One entry per concurrently
 *  running todo — its presence in WsRuntime.runs means that run is active. */
interface RunState {
  /** FRESH-session re-grounds spent on this todo (stall recovery). */
  continuations: number
  /** Decision wakes (iterations finished / verdicts in) on this todo. */
  wakes: number
  /** True while the orchestrator session is mid-turn — don't wake it then. */
  busy: boolean
  /** Monotonic run token. A todo can be stopped + restarted (editJob) reusing the
   *  same todoId/panelId; the epoch lets an in-flight reconcile from the old run
   *  detect it was superseded and bail. */
  epoch: number
}

interface WsRuntime {
  rootPath: string
  observerPanelId: string | null
  dirty: boolean
  lastObserveAt: number
  observerBusy: boolean
  lastGitSig: string | null
  /** Active orchestrator runs keyed by todoId — multiple run concurrently. */
  runs: Map<string, RunState>
  unsubGit: (() => void) | null
}

const OBSERVE_TICK_MS = 60_000
/** Max FRESH-session re-grounds before we stop nudging a stalled orchestrator. */
const MAX_CONTINUATIONS = 10
/** Max decision wakes (a flapping loop), far above any real run. */
const MAX_WAKES = 60

function gitSignature(snap: { branch?: string | null; statusFiles: Array<{ path: string; index: string; working_dir: string }> }): string {
  const files = snap.statusFiles.map((f) => `${f.path}|${f.index}${f.working_dir}`).join(',')
  return `${snap.branch ?? ''}::${files}`
}

const OBSERVE_TURN_PROMPT =
  'Workspace state below. read_terminal anything worth a look, then remark. propose_todo only for clearly worthwhile work.'

function pick<T>(xs: readonly T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]
}

const OBSERVING_STATUSES = [
  'Reading your terminals for things to do',
  'Scanning the terminals for loose ends',
  'Peeking at what your terminals are up to',
  'Having a look around the workspace',
  'Checking the terminals for work worth doing',
  'Sniffing around for something useful',
] as const

const WORKING_STATUSES = [
  (t: string) => `Working on ${t}`,
  (t: string) => `On it: ${t}`,
  (t: string) => `Heads down on ${t}`,
  (t: string) => `Tackling ${t}`,
  (t: string) => `Chipping away at ${t}`,
  (t: string) => `Making progress on ${t}`,
] as const

const SETTLED: ReadonlyArray<Todo['status']> = ['review', 'done', 'failed', 'discarded']
const isSettled = (s: Todo['status'] | undefined): boolean => !!s && SETTLED.includes(s)

function getTodo(rootPath: string, todoId: string): Todo | undefined {
  return useTodosStore.getState().getTodos(rootPath).find((t) => t.id === todoId)
}

/** First prompt for a fresh orchestrator run. */
function executePrompt(todo: Todo): string {
  return [
    `Task (todo ${todo.id}): "${todo.title}".`,
    'First update_todo with a clean 2–5 word `topic`. Then answer if it\'s a question, else run the loop.',
  ].join(' ')
}

/** Re-prompt for a FRESH orchestrator session re-grounded in the loop state (stall
 *  recovery). A clean context window, so it must be re-grounded. */
function continuePrompt(wsId: string, rootPath: string, todo: Todo): string {
  return [
    `Continue todo ${todo.id}: "${todo.title}". Loop state below — don't restart finished work.`,
    'select_winner a passer, iterate again folding in failures, or update_todo "failed".',
    `\n\n${buildOrchestratorContext(wsId, rootPath, todo.id)}`,
  ].join(' ')
}

class CateAgentController implements CateAgentBridgeHost {
  private ws = new Map<string, WsRuntime>()
  private tick: ReturnType<typeof setInterval> | null = null
  private started = false
  private orchestratorEpoch = 0

  start(): void {
    if (this.started) return
    this.started = true
    console.info('[cateAgent] controller started')
    setCateAgentBridgeHost(this)
    if (typeof window !== 'undefined') (window as unknown as { __cateAgent?: unknown }).__cateAgent = this
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.onTerminalExit((ptyId) => {
        const wsId = workspaceIdForTerminal(ptyId)
        if (wsId) this.markDirty(wsId)
      })
    }
    this.tick = setInterval(() => this.onTick(), OBSERVE_TICK_MS)
  }

  private rt(wsId: string, rootPath?: string): WsRuntime {
    let r = this.ws.get(wsId)
    if (!r) {
      r = { rootPath: rootPath ?? '', observerPanelId: null, dirty: false, lastObserveAt: 0, observerBusy: false, lastGitSig: null, runs: new Map(), unsubGit: null }
      this.ws.set(wsId, r)
    }
    if (rootPath) r.rootPath = rootPath
    return r
  }

  // --- persistence + lifecycle controls -------------------------------------

  async restore(wsId: string, rootPath: string): Promise<void> {
    try {
      await this.reconcileOrphans(rootPath)
      const state = await window.electronAPI.projectCateAgentLoad(rootPath)
      useCateAgentStore.getState().patch(wsId, { autoObserve: state.autoObserve })
      if (state.enabled) await this.summon(wsId, rootPath, state.autoObserve)
    } catch (err) {
      log.warn('[cateAgentController] restore failed for %s: %O', wsId, err)
    }
  }

  /** Settle todos left in_progress by a previous session that has no live run:
   *  a job with worktree-bearing iterations goes to review (inspect/land), the
   *  rest fail so the user can rerun. Idempotent. */
  private async reconcileOrphans(rootPath: string): Promise<void> {
    await useTodosStore.getState().loadTodos(rootPath)
    const hasLiveRun = (id: string): boolean => [...this.ws.values()].some((r) => r.runs.has(id))
    for (const t of useTodosStore.getState().getTodos(rootPath)) {
      if (t.status === 'in_progress' && !hasLiveRun(t.id)) {
        const passed = t.iterations?.find((i) => i.status === 'passed' && i.worktreeId)
        useTodosStore.getState().patchTodo(rootPath, t.id, {
          status: passed ? 'review' : t.worktreeId ? 'review' : 'failed',
          ...(passed ? { worktreeId: passed.worktreeId, branch: passed.branch } : {}),
          note: 'Interrupted — the app was restarted.',
          interrupted: true,
        })
      }
    }
  }

  private persist(wsId: string, rootPath: string): void {
    const p = useCateAgentStore.getState().get(wsId)
    void window.electronAPI.projectCateAgentSave(rootPath, { version: 1, enabled: p.enabled, autoObserve: p.autoObserve })
  }

  async summon(wsId: string, rootPath: string, autoObserve?: boolean): Promise<void> {
    this.start()
    const r = this.rt(wsId, rootPath)
    await useTodosStore.getState().loadTodos(rootPath)
    console.info('[cateAgent] summon', wsId, rootPath)
    const auto = autoObserve ?? useCateAgentStore.getState().get(wsId).autoObserve
    useCateAgentStore.getState().patch(wsId, { enabled: true, autoObserve: auto, activity: 'resting', status: '' })
    this.persist(wsId, rootPath)
    if (!r.unsubGit) {
      r.unsubGit = gitStatusStore.subscribe(
        rootPath,
        () => {
          const sig = gitSignature(gitStatusStore.getSnapshot(rootPath))
          if (sig === r.lastGitSig) return
          r.lastGitSig = sig
          this.markDirty(wsId)
        },
        wsId,
      )
    }
    if (r.observerPanelId) return
    const panelId = observerPanelId(wsId)
    const ctx: CateAgentContext = { panelId, workspaceId: wsId, rootPath, role: 'observer' }
    setContext(panelId, ctx)
    const ok = await createCateAgentSession({ panelId, rootPath, workspaceId: wsId, role: 'observer' })
    if (!ok) {
      deleteContext(panelId)
      console.warn('[cateAgent] observer session failed to start for', wsId)
      useCateAgentStore.getState().patch(wsId, { status: 'Could not start (check provider sign-in)' })
      return
    }
    console.info('[cateAgent] observer session started', panelId)
    r.observerPanelId = panelId
    this.markDirty(wsId)
  }

  observeNow(wsId: string): void {
    const r = this.ws.get(wsId)
    if (!r?.observerPanelId) {
      console.warn('[cateAgent] observeNow: no observer session for', wsId)
      return
    }
    r.lastObserveAt = Date.now()
    void this.observe(wsId, r)
  }

  /** Handle a free-form user prompt typed into the toolbar — mint a todo and run
   *  an orchestrator for it. The orchestrator owns worktrees (one per iteration),
   *  so there's no user-chosen target. */
  async prompt(wsId: string, rootPath: string, text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    this.start()
    await useTodosStore.getState().loadTodos(rootPath)
    const now = Date.now()
    const todo: Todo = {
      id: generateId(),
      title: trimmed,
      topic: deriveTopic(trimmed),
      origin: 'user',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    }
    useTodosStore.getState().upsertTodo(rootPath, todo)
    await this.runTodo(wsId, rootPath, todo.id)
  }

  async editJob(wsId: string, rootPath: string, todoId: string, newPrompt: string): Promise<void> {
    const trimmed = newPrompt.trim()
    if (!trimmed) return
    const r = this.ws.get(wsId)
    if (r?.runs.has(todoId)) this.stop(wsId, todoId)
    await disposeCateAgent(orchestratorPanelId(todoId))
    // Reset only the prompt + planning fields here. The iteration/worktree/terminal
    // layer is torn down by runTodo's clearTodoWork (which needs the refs intact to
    // find the worktrees), so don't null it out before then.
    useTodosStore.getState().patchTodo(rootPath, todoId, {
      title: trimmed,
      topic: deriveTopic(trimmed),
      status: 'pending',
      note: undefined,
      goal: undefined,
      check: undefined,
    })
    useCateAgentStore.getState().appendFeed(wsId, 'user', `Edited: ${trimmed}`)
    await this.runTodo(wsId, rootPath, todoId)
  }

  stop(wsId: string, todoId?: string): void {
    const r = this.ws.get(wsId)
    if (!r) return
    const ids = todoId ? [todoId] : [...r.runs.keys()]
    for (const id of ids) this.stopOne(wsId, r, id)
  }

  private stopOne(wsId: string, r: WsRuntime, todoId: string): void {
    r.runs.delete(todoId)
    this.disposeRunSessions(wsId, todoId)
    const todo = getTodo(r.rootPath, todoId)
    if (todo) {
      // Iterations are ephemeral: interrupting wipes the whole worktree/terminal
      // layer (and the branch). A later Continue resumes only the orchestrator,
      // which spawns fresh iterations.
      void teardownTodoWork(wsId, r.rootPath, todo, { deleteBranch: true })
      if (todo.status === 'in_progress') {
        useTodosStore.getState().patchTodo(r.rootPath, todoId, {
          status: 'failed',
          worktreeId: undefined,
          branch: undefined,
          iterations: undefined,
          round: undefined,
          recommendedIterationId: undefined,
          terminalNodeIds: undefined,
          note: 'Stopped by you.',
        })
      }
    }
    this.syncActivity(wsId)
  }

  /** Dispose the orchestrator + any per-iteration driver sessions for this todo.
   *  Deleting the driver's context then signalling its run waiter lets a parked
   *  runDriverToCompletion loop wake and bail immediately (it sees no context). */
  private disposeRunSessions(_wsId: string, todoId: string): void {
    for (const panelId of contextPanelIds()) {
      const ctx = getContext(panelId)
      if (!ctx || ctx.todoId !== todoId) continue
      void disposeCateAgent(panelId)
      deleteContext(panelId)
      signalRunEnd(panelId)
    }
  }

  private async observe(wsId: string, r: WsRuntime): Promise<void> {
    if (!r.observerPanelId) return
    const context = await buildObserveContext(wsId, r.rootPath)
    void promptCateAgent(r.observerPanelId, `${OBSERVE_TURN_PROMPT}\n\n${context}`)
  }

  async dismiss(wsId: string, rootPath: string): Promise<void> {
    const r = this.ws.get(wsId)
    if (r) {
      if (r.observerPanelId) {
        void disposeCateAgent(r.observerPanelId)
        deleteContext(r.observerPanelId)
      }
      for (const todoId of r.runs.keys()) this.disposeRunSessions(wsId, todoId)
      r.runs.clear()
      r.observerPanelId = null
      if (r.unsubGit) {
        r.unsubGit()
        r.unsubGit = null
      }
    }
    useCateAgentStore.getState().patch(wsId, { enabled: false, activity: 'off', status: '' })
    this.persist(wsId, rootPath)
  }

  setAutoObserve(wsId: string, rootPath: string, value: boolean): void {
    useCateAgentStore.getState().patch(wsId, { autoObserve: value })
    this.persist(wsId, rootPath)
    if (value) this.markDirty(wsId)
  }

  markDirty(wsId: string): void {
    const r = this.ws.get(wsId)
    if (r) r.dirty = true
  }

  private syncActivity(wsId: string): void {
    const r = this.ws.get(wsId)
    if (!r) return
    const cur = useCateAgentStore.getState().get(wsId)
    const anyRun = r.runs.size > 0
    const activity: CateAgentActivity = anyRun ? 'working' : r.observerBusy ? 'observing' : cur.enabled ? 'resting' : 'off'
    useCateAgentStore.getState().patch(wsId, { activity, status: anyRun ? cur.status : '' })
  }

  // --- orchestrator runs (concurrent) ---------------------------------------

  async runTodo(wsId: string, rootPath: string, todoId: string, resume = false): Promise<void> {
    this.start()
    const r = this.rt(wsId, rootPath)
    await useTodosStore.getState().loadTodos(rootPath)
    const cateAgent = useCateAgentStore.getState().get(wsId)
    if (!cateAgent.enabled) await this.summon(wsId, rootPath)
    if (r.runs.has(todoId)) return
    // The worktree/terminal layer is never resumed — only the orchestrator is. So
    // every start (fresh OR resume) wipes any iterations/worktrees/terminals/branch
    // a previous run left behind; a resumed orchestrator then spawns fresh ones.
    await this.clearTodoWork(wsId, rootPath, todoId)
    await this.startOrchestrator(wsId, rootPath, todoId, resume)
  }

  /** Remove every worktree + terminal a prior run of this todo left behind (and its
   *  branch) and clear the now-dead iteration-layer refs. The orchestrator's goal +
   *  check survive so a resume can re-ground; only the iteration layer is wiped. */
  private async clearTodoWork(wsId: string, rootPath: string, todoId: string): Promise<void> {
    const todo = getTodo(rootPath, todoId)
    if (!todo) return
    await teardownTodoWork(wsId, rootPath, todo, { deleteBranch: true })
    useTodosStore.getState().patchTodo(rootPath, todoId, {
      worktreeId: undefined,
      branch: undefined,
      iterations: undefined,
      round: undefined,
      recommendedIterationId: undefined,
      terminalNodeIds: undefined,
    })
  }

  async continueJob(wsId: string, rootPath: string, todoId: string): Promise<void> {
    await useTodosStore.getState().loadTodos(rootPath)
    useTodosStore.getState().patchTodo(rootPath, todoId, { interrupted: false, note: undefined })
    await this.runTodo(wsId, rootPath, todoId, true)
  }

  private async startOrchestrator(wsId: string, rootPath: string, todoId: string, resume = false): Promise<void> {
    const r = this.rt(wsId, rootPath)
    const todo = getTodo(rootPath, todoId)
    if (!todo) return
    console.info('[cateAgent] start orchestrator', todoId, todo.title)
    const epoch = ++this.orchestratorEpoch
    r.runs.set(todoId, { continuations: 0, wakes: 0, busy: false, epoch })
    const panelId = orchestratorPanelId(todoId)
    const ctx: CateAgentContext = { panelId, workspaceId: wsId, rootPath, role: 'orchestrator', todoId, epoch }
    setContext(panelId, ctx)
    useTodosStore.getState().setTodoStatus(rootPath, todoId, 'in_progress')
    useCateAgentStore.getState().patch(wsId, { activity: 'working', status: pick(WORKING_STATUSES)(todo.topic || todo.title) })
    const ok = await createCateAgentSession({ panelId, rootPath, workspaceId: wsId, role: 'orchestrator' })
    if (!ok) {
      deleteContext(panelId)
      r.runs.delete(todoId)
      useTodosStore.getState().patchTodo(rootPath, todoId, { status: 'failed', note: 'Could not start orchestrator (check provider sign-in)' })
      this.syncActivity(wsId)
      return
    }
    void promptCateAgent(panelId, resume ? continuePrompt(wsId, rootPath, todo) : executePrompt(todo))
  }

  /** Tear down the orchestrator run: dispose its sessions, drop its terminals from
   *  the glow set. */
  private finalizeOrchestrator(ctx: CateAgentContext): void {
    if (!hasContext(ctx.panelId)) return
    const r = this.ws.get(ctx.workspaceId)
    console.info('[cateAgent] finalize orchestrator', ctx.todoId)
    if (ctx.todoId) this.disposeRunSessions(ctx.workspaceId, ctx.todoId)
    if (r && ctx.todoId) r.runs.delete(ctx.todoId)
    const todo = ctx.todoId ? getTodo(ctx.rootPath, ctx.todoId) : undefined
    for (const tid of todo?.terminalNodeIds ?? []) useCateAgentStore.getState().removeControlledTerminal(ctx.workspaceId, tid)
    this.syncActivity(ctx.workspaceId)
    this.markDirty(ctx.workspaceId)
  }

  // --- the reconciler -------------------------------------------------------

  /** Advance one orchestrator run from the current todo/iteration state. Called on
   *  the orchestrator's yield (agent_end) and whenever a checker it depends on
   *  finishes. Waits on iteration terminals, runs the per-iteration checks, and
   *  wakes the orchestrator when work it cares about completes. */
  private async reconcile(ctx: CateAgentContext): Promise<void> {
    const r = this.ws.get(ctx.workspaceId)
    if (!r || !ctx.todoId || r.runs.get(ctx.todoId)?.epoch !== ctx.epoch) return // superseded
    const run = r.runs.get(ctx.todoId)!
    if (run.busy) return // orchestrator mid-turn; its agent_end will reconcile
    const todo = getTodo(ctx.rootPath, ctx.todoId)
    if (!todo) {
      this.finalizeOrchestrator(ctx)
      return
    }
    if (isSettled(todo.status)) {
      this.finalizeOrchestrator(ctx)
      return
    }

    const round = todo.round ?? 0
    const iters = (todo.iterations ?? []).filter((i) => i.round === round)

    // (A) Iterations still running. Each one's per-iteration driver flips it to
    //     `finished`/`error` when it settles; wait for that, then re-reconcile to
    //     kick off the check.
    const running = iters.filter((i) => i.status === 'running')
    if (running.length) {
      await waitForIterationsSettled(ctx.rootPath, running.map((i) => i.id))
      if (r.runs.get(ctx.todoId)?.epoch !== ctx.epoch) return
      return this.reconcile(ctx)
    }

    // (B) Finished iterations need checking. Kick a checker coding agent for each
    //     (it flips the iteration to 'verifying' and re-reconciles with a verdict).
    const finished = iters.filter((i) => i.status === 'finished')
    if (finished.length) {
      for (const it of finished) void this.runChecker(ctx, it.id)
      return
    }

    // (C) Checks in flight — wait for their verdicts to re-reconcile.
    if (iters.some((i) => i.status === 'verifying')) return

    // (D) Nothing in flight, unsettled — the orchestrator has verdicts to act on.
    //     Wake it (bounded).
    this.wakeOrchestrator(ctx)
  }

  /** Run the goal check for one finished iteration via an independent verifier
   *  driver, then record its verdict and re-reconcile. Flips the iteration to
   *  'verifying' synchronously so re-entrant reconciles don't double-launch it. */
  private async runChecker(ctx: CateAgentContext, iterationId: string): Promise<void> {
    const r = this.ws.get(ctx.workspaceId)
    if (!r || !ctx.todoId || r.runs.get(ctx.todoId)?.epoch !== ctx.epoch) return
    const todo = getTodo(ctx.rootPath, ctx.todoId)
    const iteration = todo?.iterations?.find((i) => i.id === iterationId)
    if (!todo || !iteration || iteration.status !== 'finished') return
    patchIteration(ctx.rootPath, todo.id, iterationId, { status: 'verifying' })
    const verdict = await runIterationCheck(ctx.workspaceId, ctx.rootPath, todo, iteration)
    if (r.runs.get(ctx.todoId)?.epoch !== ctx.epoch) return // superseded mid-check
    patchIteration(ctx.rootPath, todo.id, iterationId, {
      status: verdict.met ? 'passed' : 'failed',
      verify: { met: verdict.met, reason: verdict.reason, at: Date.now() },
    })
    void this.reconcile(ctx)
  }

  /** Wake the SAME orchestrator session with the current loop state, so it verifies
   *  finished iterations or decides on verdicts. Caps wakes; on overflow it auto-
   *  settles (review the first passing iteration, else fail). */
  private wakeOrchestrator(ctx: CateAgentContext): void {
    const r = this.ws.get(ctx.workspaceId)
    if (!r || !ctx.todoId) return
    const run = r.runs.get(ctx.todoId)
    if (!run || run.epoch !== ctx.epoch) return
    const todo = getTodo(ctx.rootPath, ctx.todoId)
    if (!todo) {
      this.finalizeOrchestrator(ctx)
      return
    }
    if (run.wakes >= MAX_WAKES) {
      this.settleByVerdict(ctx, todo, 'Stopped looping — too many rounds without a clear winner.')
      return
    }
    run.wakes += 1
    const prompt = [
      'Loop state below. select_winner a passer, iterate again folding in failures, or update_todo "failed".',
      `\n\n${buildOrchestratorContext(ctx.workspaceId, ctx.rootPath, todo.id)}`,
    ].join('')
    void promptCateAgent(ctx.panelId, prompt)
  }

  /** Re-ground a stalled orchestrator in a FRESH session (clean context). */
  private async continueOrchestrator(ctx: CateAgentContext): Promise<void> {
    const r = this.ws.get(ctx.workspaceId)
    if (!r || !ctx.todoId || r.runs.get(ctx.todoId)?.epoch !== ctx.epoch) return
    const todo = getTodo(ctx.rootPath, ctx.todoId)
    if (!todo) {
      this.finalizeOrchestrator(ctx)
      return
    }
    const ok = await createCateAgentSession({ panelId: ctx.panelId, rootPath: ctx.rootPath, workspaceId: ctx.workspaceId, role: 'orchestrator' })
    if (!ok) {
      this.settleByVerdict(ctx, todo, 'Could not start a follow-up orchestrator session.')
      return
    }
    if (r.runs.get(ctx.todoId)?.epoch !== ctx.epoch) return
    void promptCateAgent(ctx.panelId, continuePrompt(ctx.workspaceId, ctx.rootPath, todo))
  }

  /** Auto-settle a run that can't progress: review the first passing iteration if
   *  any, else fail. */
  private settleByVerdict(ctx: CateAgentContext, todo: Todo, note: string): void {
    const passed = todo.iterations?.find((i) => i.status === 'passed' && i.worktreeId)
    useTodosStore.getState().patchTodo(ctx.rootPath, todo.id, {
      status: passed ? 'review' : 'failed',
      ...(passed ? { worktreeId: passed.worktreeId, branch: passed.branch, recommendedIterationId: passed.id } : {}),
      note,
    })
    this.finalizeOrchestrator(ctx)
  }

  // --- observe tick ---------------------------------------------------------

  private onTick(): void {
    const now = Date.now()
    for (const [wsId, r] of this.ws) {
      const cateAgent = useCateAgentStore.getState().get(wsId)
      const todosForWs = useTodosStore.getState().getTodos(r.rootPath)
      const openSuggestions = todosForWs.filter((t) => t.status === 'suggested').length
      const fire = shouldObserve({
        enabled: cateAgent.enabled,
        autoObserve: cateAgent.autoObserve,
        dirty: r.dirty,
        observerBusy: r.observerBusy,
        orchestratorBusy: r.runs.size > 0,
        openSuggestions,
        lastObserveAt: r.lastObserveAt,
        now,
      })
      if (!fire || !r.observerPanelId) continue
      r.dirty = false
      r.lastObserveAt = now
      void this.observe(wsId, r)
    }
  }

  // --- CateAgentBridgeHost ---------------------------------------------------

  contextFor(panelId: string): CateAgentContext | null {
    return getContext(panelId)
  }

  onRunStart(ctx: CateAgentContext): void {
    // Per-iteration drivers are owned by runDriverToCompletion (codingAgentLauncher);
    // they don't drive the observe/execute loops or the global activity state.
    if (ctx.role === 'driver') return
    const r = this.ws.get(ctx.workspaceId)
    if (ctx.role === 'observer') {
      if (r) r.observerBusy = true
      const cateAgent = useCateAgentStore.getState().get(ctx.workspaceId)
      if (cateAgent.activity === 'resting') useCateAgentStore.getState().patch(ctx.workspaceId, { activity: 'observing', status: pick(OBSERVING_STATUSES) })
      return
    }
    if (ctx.role === 'orchestrator' && r && ctx.todoId) {
      const run = r.runs.get(ctx.todoId)
      if (run && run.epoch === ctx.epoch) run.busy = true
    }
    useCateAgentStore.getState().patch(ctx.workspaceId, { activity: 'working' })
  }

  onRunEnd(ctx: CateAgentContext): void {
    // A driver run ending is the settle signal that runDriverToCompletion awaits (via
    // the bridge's signalRunEnd); the driver loop owns dispose + cleanup, so the
    // controller does nothing here.
    if (ctx.role === 'driver') return
    const r = this.ws.get(ctx.workspaceId)
    if (ctx.role === 'observer') {
      if (r) r.observerBusy = false
      const cateAgent = useCateAgentStore.getState().get(ctx.workspaceId)
      if (cateAgent.enabled && cateAgent.activity === 'observing') {
        useCateAgentStore.getState().patch(ctx.workspaceId, { activity: r && r.runs.size > 0 ? 'working' : 'resting', status: '' })
      }
      return
    }
    // Orchestrator yielded. Clear busy, then reconcile (or stall-recover).
    if (ctx.todoId && r) {
      const run = r.runs.get(ctx.todoId)
      if (run && run.epoch === ctx.epoch) run.busy = false
      else return // superseded
      const todo = getTodo(ctx.rootPath, ctx.todoId)
      if (isSettled(todo?.status)) {
        this.finalizeOrchestrator(ctx)
        return
      }
      // A turn that launched/queued work leaves something pending (authoring,
      // running iterations, or verifying) — reconcile drives it. A turn that left
      // NOTHING pending is a stall → re-ground in a fresh session (bounded).
      if (this.hasPendingWork(ctx.workspaceId, ctx.rootPath, ctx.todoId)) {
        void this.reconcile(ctx)
        return
      }
      if (run.continuations < MAX_CONTINUATIONS) {
        run.continuations += 1
        void this.continueOrchestrator(ctx)
        return
      }
      if (todo) {
        this.settleByVerdict(ctx, todo, 'Stopped — the orchestrator stalled with no progress.')
        return
      }
    }
    this.finalizeOrchestrator(ctx)
  }

  /** Is the orchestrator waiting on something the controller drives — a running,
   *  finished (awaiting check), or verifying iteration? If not, its yield was a stall. */
  private hasPendingWork(_wsId: string, rootPath: string, todoId: string): boolean {
    const todo = getTodo(rootPath, todoId)
    if (!todo) return false
    const round = todo.round ?? 0
    return (todo.iterations ?? []).some((i) => i.round === round && (i.status === 'running' || i.status === 'verifying' || i.status === 'finished'))
  }

  onError(ctx: CateAgentContext, message: string): void {
    log.warn('[cateAgentController] %s error: %s', ctx.panelId, message)
    if (ctx.role === 'driver') return // launcher owns driver cleanup
    if (ctx.role === 'orchestrator' && ctx.todoId) {
      useCateAgentStore.getState().appendFeed(ctx.workspaceId, 'error', message.slice(0, 200))
      useTodosStore.getState().patchTodo(ctx.rootPath, ctx.todoId, { status: 'failed', note: message.slice(0, 200) })
      this.finalizeOrchestrator(ctx)
    } else {
      const r = this.ws.get(ctx.workspaceId)
      if (r) r.observerBusy = false
    }
  }
}

export const cateAgentController = new CateAgentController()
