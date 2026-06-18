// =============================================================================
// cateAgentController — the Cate Agent's brain (renderer, main window).
//
// Owns the headless sessions and both loops:
//   - Observer: an always-on session per enabled workspace. A 60s tick consults
//     the pure trigger gate; when it passes, the observer takes ONE turn and may
//     propose_todo. Proposals land as `suggested` todos for the user to approve.
//   - Executor: an ephemeral session per todo the user starts (runTodo). Multiple
//     run CONCURRENTLY per workspace (tracked in WsRuntime.runs, keyed by todoId).
//     Each orchestrates terminals in an isolated worktree and ends by moving the
//     todo to `review`.
//
// Implements CateAgentBridgeHost so the bridge can resolve session context and
// report turn lifecycle. State here is per-workspace and not persisted beyond the
// enabled + autoObserve flags (.cate/cateAgent.json); in-flight executors are NOT
// resumed after a restart — restore() reconciles their orphaned in_progress todos.
// =============================================================================

import type { Todo, CateAgentActivity } from '../../shared/types'
import type { CateAgentBridgeHost, CateAgentContext } from './cateAgentTypes'
import { setCateAgentBridgeHost } from './cateAgentBridge'
import {
  observerPanelId,
  executorPanelId,
  createCateAgentSession,
  promptCateAgent,
  disposeCateAgent,
} from './cateAgentSession'
import { shouldObserve } from './cateAgentTriggerGate'
import {
  buildObserveContext,
  buildExecutorContext,
  todoHasBusyTerminal,
  waitForTerminalSignal,
} from './cateAgentTools'
import { loadCateAgentExecutorAgentCommand } from '../../agent/renderer/agentModelPrefs'
import { useCateAgentStore } from './cateAgentStore'
import { useTodosStore } from '../stores/todosStore'
import { generateId } from '../stores/canvas/helpers'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { workspaceIdForTerminal } from '../stores/statusStore'
import { gitStatusStore } from '../stores/gitStatusStore'
import log from '../lib/logger'

/** Per-run executor state (stall/wake bounding). One entry per concurrently
 *  running todo — its presence in WsRuntime.runs means that executor is active. */
interface RunState {
  /** FRESH-session re-grounds spent on this todo (stall recovery). */
  continuations: number
  /** Event-driven wakes (terminal parked/exited) on this todo. */
  wakes: number
  /** Monotonic run token. A todo can be stopped + restarted (editJob) reusing the
   *  same todoId/panelId; the epoch lets an in-flight wake/continuation from the
   *  old run detect that it was superseded and bail. */
  epoch: number
}

interface WsRuntime {
  rootPath: string
  observerPanelId: string | null
  /** gate state */
  dirty: boolean
  lastObserveAt: number
  observerBusy: boolean
  /** Last git-status signature, so a no-op refresh (focus/poll) doesn't mark dirty. */
  lastGitSig: string | null
  /** Active executors keyed by todoId — multiple run concurrently. */
  runs: Map<string, RunState>
  /** unsubscribe from this workspace's git-status dirty source */
  unsubGit: (() => void) | null
}

const OBSERVE_TICK_MS = 60_000
/** Max FRESH-session re-grounds before we stop nudging an executor that keeps
 *  stalling (ending its run with nothing running and the todo unsettled). Bounds
 *  cost + infinite loops; when hit, the todo moves to a user-actionable state. */
const MAX_EXEC_CONTINUATIONS = 10
/** Runaway backstop on event-driven wakes (a flapping CLI), far above any real
 *  orchestration. When hit, the todo is handed to review/failed like the cap above. */
const MAX_EXEC_WAKES = 80

/** A content signature of the working tree, so window-focus / poll refreshes that
 *  don't actually change anything don't count as "the user did something". */
function gitSignature(snap: { branch?: string | null; statusFiles: Array<{ path: string; index: string; working_dir: string }> }): string {
  const files = snap.statusFiles.map((f) => `${f.path}|${f.index}${f.working_dir}`).join(',')
  return `${snap.branch ?? ''}::${files}`
}

const OBSERVE_TURN_PROMPT =
  'Here is the current workspace state. read_terminal any terminal you want a closer look at, then remark with a short update. Propose a todo only if there is clearly worthwhile work.'

/** Pick a random element — used to vary the Cate Agent's status wording so the same state
 *  doesn't always read identically. */
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

const WAKE_PROMPT =
  'A terminal you are driving just parked, needs input, or exited. Here are the current terminal states — read_terminal any you need a closer look at, then drive them onward (or launch more CLIs).'

/** Prompt for a FRESH executor session picking up a partially-done todo. Each
 *  loop iteration is a new session with a clean context window (not a retry), so
 *  it must be re-grounded in the state the previous sessions left on the todo:
 *  the worktree and the open terminals. */
function continuePrompt(todo: Todo): string {
  const lines = [
    `Continue an ALREADY-STARTED approved todo (id: ${todo.id}): "${todo.title}".`,
    'This is a FRESH orchestration session: earlier sessions did partial work. Pick up where they left off — do NOT start over.',
  ]
  if (todo.branch) {
    lines.push(
      `Work continues in the isolated worktree on branch \`${todo.branch}\` — every terminal you open runs inside it automatically.`,
    )
  }
  const terminals = todo.terminalNodeIds ?? []
  if (terminals.length) {
    lines.push(
      `Terminals already open for this todo: ${terminals.join(', ')}. read_terminal each FIRST to learn what the coding-agent CLI has already done before doing anything else.`,
    )
  }
  if (todo.note) lines.push(`Last note: ${todo.note}`)
  lines.push(
    `Finish the remaining work, then settle the todo: update_todo status "review" once it is written and verified${todo.branch ? ' and committed on the branch' : ''}, or "failed" with a short note if it cannot be done.`,
  )
  return lines.join(' ')
}

function executePrompt(todoId: string, title: string, hasWorktree: boolean): string {
  const cmd = loadCateAgentExecutorAgentCommand()
  const launch = cmd
    ? `When code work is needed, launch the coding-agent CLI with \`${cmd}\` and give it the task as its prompt.`
    : 'When code work is needed, launch an installed coding-agent CLI (e.g. `claude`, `codex`, or `aider`) and give it the task as its prompt.'
  const where = hasWorktree
    ? 'For code work, an isolated worktree is prepared automatically when you open your first terminal; terminals run inside it, so have the agent commit on that branch.'
    : 'This is not a git repo, so there is no worktree; terminals run in the project root.'
  return [
    `Carry out this approved todo (id: ${todoId}): "${title}".`,
    'Decide what it needs: if it is a question or a canvas/terminal management request (e.g. close, focus, or list terminals/panels), do it DIRECTLY with your own tools — do not spawn a CLI — and finish with answer (for a question/result) or update_todo.',
    `If it requires code changes, delegate. ${where} ${launch}`,
  ].join(' ')
}

class CateAgentController implements CateAgentBridgeHost {
  private ws = new Map<string, WsRuntime>()
  private ctxByPanel = new Map<string, CateAgentContext>()
  private tick: ReturnType<typeof setInterval> | null = null
  private started = false
  /** Monotonic run-token source for RunState.epoch (see RunState). */
  private execEpoch = 0

  /** Wire the bridge + start the observe tick. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    console.info('[cateAgent] controller started')
    setCateAgentBridgeHost(this)
    // Expose for manual debugging from DevTools: __cateAgent.observeNow(wsId).
    if (typeof window !== 'undefined') (window as unknown as { __cateAgent?: unknown }).__cateAgent = this
    // A completed command is a clean follow-up signal for the observer.
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

  /** Read .cate/cateAgent.json on workspace open; re-summon if it was enabled. */
  async restore(wsId: string, rootPath: string): Promise<void> {
    try {
      // Executors are NOT resumed across restarts (their CLIs' PTYs die on quit),
      // so any todo persisted as in_progress is an orphan from a prior session —
      // settle it instead of leaving a dead run spinning forever.
      await this.reconcileOrphans(rootPath)
      const state = await window.electronAPI.projectCateAgentLoad(rootPath)
      // Mirror the persisted preference even when the Cate Agent stays dismissed, so the
      // Settings toggle reflects the saved choice the moment a workspace opens.
      useCateAgentStore.getState().patch(wsId, { autoObserve: state.autoObserve })
      if (state.enabled) {
        await this.summon(wsId, rootPath, state.autoObserve)
      }
    } catch (err) {
      log.warn('[cateAgentController] restore failed for %s: %O', wsId, err)
    }
  }

  /** Settle todos left in_progress by a previous session that has no live run:
   *  worktree work goes to review (inspect/land), everything else fails so the
   *  user can rerun. Idempotent — only touches in_progress with no active run. */
  private async reconcileOrphans(rootPath: string): Promise<void> {
    await useTodosStore.getState().loadTodos(rootPath)
    const hasLiveRun = (id: string): boolean => [...this.ws.values()].some((r) => r.runs.has(id))
    for (const t of useTodosStore.getState().getTodos(rootPath)) {
      if (t.status === 'in_progress' && !hasLiveRun(t.id)) {
        useTodosStore.getState().patchTodo(rootPath, t.id, {
          status: t.worktreeId ? 'review' : 'failed',
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
    // Load this workspace's todos before the observer can read or mutate them.
    // Otherwise propose_todo's upsert runs against an unloaded ([]) list and
    // persists OVER todos.json, wiping the user's existing tasks. Idempotent
    // with any other todos load (force-guarded).
    await useTodosStore.getState().loadTodos(rootPath)
    console.info('[cateAgent] summon', wsId, rootPath)
    // Keep the current autoObserve preference unless the caller overrides it.
    const auto = autoObserve ?? useCateAgentStore.getState().get(wsId).autoObserve
    useCateAgentStore.getState().patch(wsId, { enabled: true, autoObserve: auto, activity: 'resting', status: '' })
    this.persist(wsId, rootPath)
    // Git working-tree changes are the observer's main "user is doing something"
    // signal. Subscribe once per workspace; the listener just marks dirty.
    if (!r.unsubGit) {
      // Only mark dirty when the working tree genuinely changed — the store
      // notifies on every refresh (window focus, FS poll, branch-update event),
      // and observing on a no-op refresh is exactly the noise we want to avoid.
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
    if (r.observerPanelId) return // already running
    const panelId = observerPanelId(wsId)
    const ctx: CateAgentContext = { panelId, workspaceId: wsId, rootPath, role: 'observer' }
    this.ctxByPanel.set(panelId, ctx)
    const ok = await createCateAgentSession({ panelId, rootPath, workspaceId: wsId, role: 'observer' })
    if (!ok) {
      this.ctxByPanel.delete(panelId)
      console.warn('[cateAgent] observer session failed to start for', wsId)
      useCateAgentStore.getState().patch(wsId, { status: 'Could not start (check provider sign-in)' })
      return
    }
    console.info('[cateAgent] observer session started', panelId)
    r.observerPanelId = panelId
    this.markDirty(wsId) // prime a first look
  }

  /** Force one observe turn now (debug + manual nudge), bypassing the gate. */
  observeNow(wsId: string): void {
    const r = this.ws.get(wsId)
    if (!r?.observerPanelId) {
      console.warn('[cateAgent] observeNow: no observer session for', wsId)
      return
    }
    console.info('[cateAgent] observeNow', wsId)
    r.lastObserveAt = Date.now()
    void this.observe(wsId, r)
  }

  /** Handle a free-form user prompt typed into the toolbar input bar. The chat
   *  drives the EXECUTOR directly: the request becomes a todo that runs
   *  immediately (no approval gate). The UI only allows sending while idle (you
   *  must Stop a running task first), so this always starts a fresh run. The
   *  autonomous observer is unaffected. */
  async prompt(wsId: string, rootPath: string, text: string, target: 'new' | 'root' | string = 'new'): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    this.start()
    useCateAgentStore.getState().appendFeed(wsId, 'user', trimmed)
    await useTodosStore.getState().loadTodos(rootPath)
    const now = Date.now()
    const todo: Todo = {
      id: generateId(),
      title: trimmed,
      origin: 'user',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      // 'new' → mint a fresh worktree (default); 'root' → run with no worktree;
      // otherwise an existing worktree id to reuse.
      ...(target === 'root' ? { noWorktree: true } : target !== 'new' ? { worktreeId: target } : {}),
    }
    useTodosStore.getState().upsertTodo(rootPath, todo)
    // runTodo summons the Cate Agent if it isn't enabled yet, then starts the
    // executor for this todo.
    await this.runTodo(wsId, rootPath, todo.id)
  }

  /** Edit a job: replace its prompt and restart it from scratch. Stops any live
   *  run, rewrites the prompt (title) + clears the derived topic, resets it to
   *  pending, and re-runs (reusing the same worktree). */
  async editJob(wsId: string, rootPath: string, todoId: string, newPrompt: string): Promise<void> {
    const trimmed = newPrompt.trim()
    if (!trimmed) return
    const r = this.ws.get(wsId)
    if (r?.runs.has(todoId)) this.stop(wsId, todoId)
    // Fully tear down the old session before reusing its panelId, so a trailing
    // event from it can't attach to the restarted run.
    await disposeCateAgent(executorPanelId(todoId))
    useTodosStore.getState().patchTodo(rootPath, todoId, { title: trimmed, topic: undefined, status: 'pending', note: undefined })
    useCateAgentStore.getState().appendFeed(wsId, 'user', `Edited: ${trimmed}`)
    await this.runTodo(wsId, rootPath, todoId)
  }

  /** Stop a specific running job (todoId), or all jobs in the workspace when no
   *  todoId is given. Removing the run first makes the trailing agent_end a no-op
   *  (no continue/settle race). */
  stop(wsId: string, todoId?: string): void {
    const r = this.ws.get(wsId)
    if (!r) return
    // For a specific todo, tear it down even if there's no live run entry (e.g. an
    // orphaned in_progress todo from a prior session) so Stop always settles it.
    const ids = todoId ? [todoId] : [...r.runs.keys()]
    for (const id of ids) this.stopOne(wsId, r, id)
  }

  private stopOne(wsId: string, r: WsRuntime, todoId: string): void {
    const panelId = executorPanelId(todoId)
    r.runs.delete(todoId)
    this.ctxByPanel.delete(panelId)
    void disposeCateAgent(panelId)
    const todo = useTodosStore.getState().getTodos(r.rootPath).find((t) => t.id === todoId)
    // Disposing the orchestrator doesn't touch the CLIs it spawned, so interrupt
    // each of the run's terminals (Ctrl-C) and drop them from the glow set.
    for (const tid of todo?.terminalNodeIds ?? []) {
      const ptyId = terminalRegistry.ptyIdForPanel(tid)
      if (ptyId) {
        try {
          void window.electronAPI.terminalWrite(ptyId, '\x03')
        } catch {
          /* terminal already gone */
        }
      }
      useCateAgentStore.getState().removeControlledTerminal(wsId, tid)
    }
    if (todo?.status === 'in_progress') {
      // Keep any partial work reviewable (worktree) or done (non-git); a run that
      // never opened a terminal just failed.
      useTodosStore.getState().patchTodo(r.rootPath, todoId, {
        status: todo.terminalNodeIds?.length ? (todo.worktreeId ? 'review' : 'done') : 'failed',
        note: 'Stopped by you.',
      })
    }
    useCateAgentStore.getState().appendFeed(wsId, 'status', `Stopped "${todo?.title ?? 'task'}".`)
    this.syncActivity(wsId)
  }

  /** Take one observe turn: snapshot the workspace and prompt the observer with
   *  it injected, so it doesn't burn tool calls rediscovering known state. */
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
        this.ctxByPanel.delete(r.observerPanelId)
      }
      for (const todoId of r.runs.keys()) {
        const panelId = executorPanelId(todoId)
        void disposeCateAgent(panelId)
        this.ctxByPanel.delete(panelId)
      }
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

  /** Toggle automatic observe turns. When turned back on, prime a look so the Cate Agent
   *  catches up on anything that changed while it was quiet. The manual nudge
   *  (clicking the idle Cate Agent) works regardless of this setting. */
  setAutoObserve(wsId: string, rootPath: string, value: boolean): void {
    useCateAgentStore.getState().patch(wsId, { autoObserve: value })
    this.persist(wsId, rootPath)
    if (value) this.markDirty(wsId)
  }

  markDirty(wsId: string): void {
    const r = this.ws.get(wsId)
    if (r) r.dirty = true
  }

  /** Reflect the running-set into the workspace-level activity. Working wins while
   *  any executor runs; otherwise observing (observer mid-turn) then resting/off.
   *  Called whenever the running set changes. */
  private syncActivity(wsId: string): void {
    const r = this.ws.get(wsId)
    if (!r) return
    const cur = useCateAgentStore.getState().get(wsId)
    const anyRun = r.runs.size > 0
    const activity: CateAgentActivity = anyRun ? 'working' : r.observerBusy ? 'observing' : cur.enabled ? 'resting' : 'off'
    useCateAgentStore.getState().patch(wsId, { activity, status: anyRun ? cur.status : '' })
  }

  // --- executors (run concurrently) -----------------------------------------

  /** Start execution of an approved/started todo. Multiple run concurrently, each
   *  in its own worktree + session; a todo already running is a no-op. */
  async runTodo(wsId: string, rootPath: string, todoId: string, resume = false): Promise<void> {
    this.start()
    const r = this.rt(wsId, rootPath)
    // Ensure todos are loaded before the executor reads/mutates them (summon
    // also loads, but an already-enabled Cate Agent skips summon here).
    await useTodosStore.getState().loadTodos(rootPath)
    const cateAgent = useCateAgentStore.getState().get(wsId)
    if (!cateAgent.enabled) {
      // Allow "run with Cate Agent" to implicitly summon.
      await this.summon(wsId, rootPath)
    }
    if (r.runs.has(todoId)) return // already running this job
    // One agent per worktree (or per project root for no-worktree jobs). A 'new'
    // job mints its own fresh worktree, so it never conflicts; only a job pinned
    // to an existing worktree or the root can collide with a running one.
    const todo = useTodosStore.getState().getTodos(rootPath).find((t) => t.id === todoId)
    const key = this.worktreeKeyOf(todo)
    if (key) {
      const occupied = [...r.runs.keys()].some(
        (rid) => rid !== todoId && this.worktreeKeyOf(useTodosStore.getState().getTodos(rootPath).find((t) => t.id === rid)) === key,
      )
      if (occupied) {
        const where = key === 'root' ? 'the project root' : 'that worktree'
        useCateAgentStore.getState().appendFeed(wsId, 'error', `A job is already running in ${where} — stop it before starting another.`)
        return
      }
    }
    await this.startExecutor(wsId, rootPath, todoId, resume)
  }

  /** Resume a job that was cut short (interrupted by an app restart). Re-runs the
   *  executor in CONTINUE mode — a fresh session re-grounded in the existing
   *  worktree + terminals to pick up where it left off, not a from-scratch run. */
  async continueJob(wsId: string, rootPath: string, todoId: string): Promise<void> {
    await useTodosStore.getState().loadTodos(rootPath)
    // Clear the interrupted marker + its note so the card stops presenting it as
    // settled the moment we resume.
    useTodosStore.getState().patchTodo(rootPath, todoId, { interrupted: false, note: undefined })
    const title = useTodosStore.getState().getTodos(rootPath).find((t) => t.id === todoId)?.title ?? 'task'
    useCateAgentStore.getState().appendFeed(wsId, 'status', `Resuming "${title}"`)
    await this.runTodo(wsId, rootPath, todoId, true)
  }

  /** The worktree a todo will run in, as a conflict key: 'root' for a no-worktree
   *  job, the worktreeId for a pinned one, or null when it'll mint a fresh
   *  worktree (which can never conflict). */
  private worktreeKeyOf(todo: Todo | undefined): string | null {
    if (!todo) return null
    if (todo.noWorktree) return 'root'
    return todo.worktreeId ?? null
  }

  /** Whether this todo will run in an isolated worktree once it does code work —
   *  true if it already has one, or it's a git repo and the user didn't opt out.
   *  Read-only: used only to phrase the executor prompt (the worktree itself is
   *  created lazily on the first create_terminal). */
  private async willHaveWorktree(rootPath: string, todo: Todo): Promise<boolean> {
    if (todo.worktreeId) return true
    if (todo.noWorktree) return false
    try {
      return await window.electronAPI.gitIsRepo(rootPath)
    } catch {
      return false
    }
  }

  private async startExecutor(wsId: string, rootPath: string, todoId: string, resume = false): Promise<void> {
    const r = this.rt(wsId, rootPath)
    const todo = useTodosStore.getState().getTodos(rootPath).find((t) => t.id === todoId)
    if (!todo) return
    console.info('[cateAgent] start executor', todoId, todo.title)
    const epoch = ++this.execEpoch
    r.runs.set(todoId, { continuations: 0, wakes: 0, epoch })
    const panelId = executorPanelId(todoId)
    const ctx: CateAgentContext = { panelId, workspaceId: wsId, rootPath, role: 'executor', todoId, epoch }
    this.ctxByPanel.set(panelId, ctx)
    useTodosStore.getState().setTodoStatus(rootPath, todoId, 'in_progress')
    useCateAgentStore.getState().patch(wsId, { activity: 'working', status: pick(WORKING_STATUSES)(todo.title) })
    useCateAgentStore.getState().appendFeed(wsId, 'status', `Working on "${todo.title}"`)
    // The worktree is created LAZILY (on the first create_terminal) so a pure
    // question or management job never mints a throwaway branch. Here we only
    // determine WHETHER one will appear — to phrase the prompt — without creating it.
    const willHaveWorktree = await this.willHaveWorktree(rootPath, todo)
    const ok = await createCateAgentSession({ panelId, rootPath, workspaceId: wsId, role: 'executor' })
    if (!ok) {
      this.ctxByPanel.delete(panelId)
      r.runs.delete(todoId)
      useTodosStore.getState().patchTodo(rootPath, todoId, { status: 'failed', note: 'Could not start executor (check provider sign-in)' })
      this.syncActivity(wsId)
      return
    }
    // Resuming an interrupted job re-grounds a fresh session in the work the prior
    // session left behind (worktree + terminals); a normal run starts from scratch.
    void promptCateAgent(panelId, resume ? continuePrompt(todo) : executePrompt(todoId, todo.title, willHaveWorktree))
  }

  private finalizeExecutor(ctx: CateAgentContext): void {
    // Idempotent: agent_end and the safety paths can both land here.
    if (!this.ctxByPanel.has(ctx.panelId)) return
    const r = this.ws.get(ctx.workspaceId)
    console.info('[cateAgent] finalize executor', ctx.todoId)
    void disposeCateAgent(ctx.panelId)
    this.ctxByPanel.delete(ctx.panelId)
    if (r && ctx.todoId) r.runs.delete(ctx.todoId)
    // Drop only THIS run's terminals from the glow set (other jobs keep theirs).
    const todo = ctx.todoId ? useTodosStore.getState().getTodos(ctx.rootPath).find((t) => t.id === ctx.todoId) : undefined
    for (const tid of todo?.terminalNodeIds ?? []) useCateAgentStore.getState().removeControlledTerminal(ctx.workspaceId, tid)
    this.syncActivity(ctx.workspaceId)
    this.markDirty(ctx.workspaceId) // a finished todo is a follow-up signal
  }

  /** Loop iteration: replace the spent executor session with a FRESH one for the
   *  same todo and re-prompt it with the rebuilt state. The panelId is derived
   *  from the todoId, so re-creating it disposes the old pi session and starts a
   *  clean one (no transcript resume — a brand-new context window). */
  private async continueExecutor(ctx: CateAgentContext): Promise<void> {
    const r = this.ws.get(ctx.workspaceId)
    if (!r || !ctx.todoId || r.runs.get(ctx.todoId)?.epoch !== ctx.epoch) return // dismissed / stopped / restarted
    const todo = ctx.todoId ? useTodosStore.getState().getTodos(ctx.rootPath).find((t) => t.id === ctx.todoId) : undefined
    if (!todo) {
      this.finalizeExecutor(ctx)
      return
    }
    // No eager worktree here: a continuation reuses the one the job already made
    // (create_terminal makes it lazily on first use), so a job that only opened
    // terminals has its tree, and one that never did still hasn't minted a stray.
    const ok = await createCateAgentSession({ panelId: ctx.panelId, rootPath: ctx.rootPath, workspaceId: ctx.workspaceId, role: 'executor' })
    if (!ok) {
      useTodosStore.getState().patchTodo(ctx.rootPath, todo.id, { status: 'failed', note: 'Could not start a follow-up executor session.' })
      this.finalizeExecutor(ctx)
      return
    }
    if (r.runs.get(ctx.todoId)?.epoch !== ctx.epoch) return // superseded while creating the session
    void promptCateAgent(ctx.panelId, continuePrompt(todo))
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
        executorBusy: r.runs.size > 0,
        openSuggestions,
        lastObserveAt: r.lastObserveAt,
        now,
      })
      if (!fire || !r.observerPanelId) continue
      console.info('[cateAgent] observe turn', wsId)
      r.dirty = false
      r.lastObserveAt = now
      void this.observe(wsId, r)
    }
  }

  // --- CateAgentBridgeHost ---------------------------------------------------------

  contextFor(panelId: string): CateAgentContext | null {
    return this.ctxByPanel.get(panelId) ?? null
  }

  onRunStart(ctx: CateAgentContext): void {
    const r = this.ws.get(ctx.workspaceId)
    if (ctx.role === 'observer') {
      if (r) r.observerBusy = true
      const cateAgent = useCateAgentStore.getState().get(ctx.workspaceId)
      if (cateAgent.activity === 'resting') useCateAgentStore.getState().patch(ctx.workspaceId, { activity: 'observing', status: pick(OBSERVING_STATUSES) })
    } else {
      useCateAgentStore.getState().patch(ctx.workspaceId, { activity: 'working' })
    }
  }

  onRunEnd(ctx: CateAgentContext): void {
    const r = this.ws.get(ctx.workspaceId)
    if (ctx.role === 'observer') {
      if (r) r.observerBusy = false
      const cateAgent = useCateAgentStore.getState().get(ctx.workspaceId)
      if (cateAgent.enabled && cateAgent.activity === 'observing') {
        useCateAgentStore.getState().patch(ctx.workspaceId, { activity: r && r.runs.size > 0 ? 'working' : 'resting', status: '' })
      }
      return
    }
    // Executor run ended. The orchestrator yields its turn whenever it has
    // dispatched work and is waiting on the CLIs, so a run ending is NOT
    // completion: only a todo that reached review/failed/done is settled.
    if (ctx.todoId && r) {
      const todo = useTodosStore.getState().getTodos(ctx.rootPath).find((t) => t.id === ctx.todoId)
      const status = todo?.status
      const settled = status === 'review' || status === 'failed' || status === 'done'
      if (!settled) {
        // Work still in flight → yield: wait (event-driven) for a terminal to park
        // or exit, then wake the SAME session — preserves orchestration context and
        // never busy-loops. Nothing running → the agent stalled, so re-ground it in
        // a FRESH session (clean context window), bounded by the continuation cap.
        if (todoHasBusyTerminal(ctx.workspaceId, ctx.rootPath, ctx.todoId)) {
          void this.scheduleWake(ctx)
          return
        }
        const runState = r.runs.get(ctx.todoId)
        if (runState && runState.continuations < MAX_EXEC_CONTINUATIONS) {
          runState.continuations += 1
          console.info('[cateAgent] executor continue', ctx.todoId, runState.continuations)
          void this.continueExecutor(ctx)
          return
        }
      }
    }
    this.settleStuckTodo(ctx)
  }

  /** Leave an unsettled todo in a clear, user-actionable state, then dispose the
   *  executor — never orphan an in_progress one. */
  private settleStuckTodo(ctx: CateAgentContext): void {
    if (ctx.todoId) {
      const todo = useTodosStore.getState().getTodos(ctx.rootPath).find((t) => t.id === ctx.todoId)
      if (todo?.status === 'in_progress') {
        // Opened a terminal (started delegating) → hand the partial work onward;
        // otherwise it never started, so fail it so the user isn't left stuck.
        if (todo.terminalNodeIds?.length) {
          // Only worktree-based (git) todos get the review/land gate. A non-git
          // todo's work is already in the project root, so it settles as done.
          const landable = !!todo.worktreeId
          useTodosStore.getState().patchTodo(ctx.rootPath, ctx.todoId, {
            status: landable ? 'review' : 'done',
            note: todo.note ?? (landable ? 'Executor ended — review the partial work.' : 'Executor ended — work left in the project.'),
          })
        } else {
          useTodosStore.getState().patchTodo(ctx.rootPath, ctx.todoId, {
            status: 'failed',
            note: 'Executor ended before starting any work.',
          })
        }
      }
    }
    this.finalizeExecutor(ctx)
  }

  /** Executor yielded with CLIs still working. Wait (event-driven) until a
   *  terminal parks/exits, then re-prompt the SAME live session with the current
   *  terminal states injected. A wake cap backstops a flapping CLI. */
  private async scheduleWake(ctx: CateAgentContext): Promise<void> {
    if (!ctx.todoId) return
    await waitForTerminalSignal(ctx.workspaceId, ctx.rootPath, ctx.todoId)
    const r = this.ws.get(ctx.workspaceId)
    // Bail if dismissed, stopped, or restarted (epoch changed) while we waited.
    if (!r || r.runs.get(ctx.todoId)?.epoch !== ctx.epoch) return
    const todo = useTodosStore.getState().getTodos(ctx.rootPath).find((t) => t.id === ctx.todoId)
    const settled = todo?.status === 'review' || todo?.status === 'failed' || todo?.status === 'done'
    const runState = r.runs.get(ctx.todoId)
    if (settled || !runState || runState.wakes >= MAX_EXEC_WAKES) {
      this.settleStuckTodo(ctx)
      return
    }
    runState.wakes += 1
    console.info('[cateAgent] executor wake', ctx.todoId, runState.wakes)
    void promptCateAgent(ctx.panelId, `${WAKE_PROMPT}\n\n${buildExecutorContext(ctx.workspaceId, ctx.rootPath, ctx.todoId)}`)
  }

  onError(ctx: CateAgentContext, message: string): void {
    log.warn('[cateAgentController] %s error: %s', ctx.panelId, message)
    if (ctx.role === 'executor' && ctx.todoId) {
      useCateAgentStore.getState().appendFeed(ctx.workspaceId, 'error', message.slice(0, 200))
      useTodosStore.getState().patchTodo(ctx.rootPath, ctx.todoId, { status: 'failed', note: message.slice(0, 200) })
      this.finalizeExecutor(ctx)
    } else {
      const r = this.ws.get(ctx.workspaceId)
      if (r) r.observerBusy = false
    }
  }
}

export const cateAgentController = new CateAgentController()
