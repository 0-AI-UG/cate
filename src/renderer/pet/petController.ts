// =============================================================================
// petController — the Canvas Pet's brain (renderer, main window).
//
// Owns the headless sessions and both loops:
//   - Observer: an always-on session per enabled workspace. A 60s tick consults
//     the pure trigger gate; when it passes, the observer takes ONE turn and may
//     propose_todo. Proposals land as `suggested` todos for the user to approve.
//   - Executor: an ephemeral session per todo the user starts (runTodo). One at a
//     time per workspace (the rest queue). It orchestrates terminals in an
//     isolated worktree and ends by moving the todo to `review`.
//
// Implements PetBridgeHost so the bridge can resolve session context and report
// turn lifecycle. State here is per-workspace and not persisted beyond the
// enabled/paused flags (.cate/pet.json); in-flight executors are re-queued, not
// resumed, after a restart.
// =============================================================================

import type { Todo } from '../../shared/types'
import type { PetBridgeHost, PetContext } from './petTypes'
import { setPetBridgeHost } from './petBridge'
import {
  observerPanelId,
  executorPanelId,
  createPetSession,
  promptPet,
  interruptPet,
  disposePet,
} from './petSession'
import { shouldObserve } from './petTriggerGate'
import {
  ensureTodoWorktree,
  buildObserveContext,
  buildExecutorContext,
  todoHasBusyTerminal,
  waitForTerminalSignal,
} from './petTools'
import { loadPetExecutorAgentCommand } from '../../agent/renderer/agentModelPrefs'
import { usePetStore } from './petStore'
import { useTodosStore } from '../stores/todosStore'
import { workspaceIdForTerminal } from '../stores/statusStore'
import { useAppStore } from '../stores/appStore'
import { gitStatusStore } from '../stores/gitStatusStore'
import log from '../lib/logger'

interface WsRuntime {
  rootPath: string
  observerPanelId: string | null
  /** gate state */
  dirty: boolean
  lastObserveAt: number
  observerBusy: boolean
  /** Last git-status signature, so a no-op refresh (focus/poll) doesn't mark dirty. */
  lastGitSig: string | null
  /** executor */
  runningTodoId: string | null
  /** Number of FRESH-session re-grounds spent on the current todo (stall recovery). */
  execContinuations: number
  /** Number of event-driven wakes (terminal parked/exited) on the current todo. */
  execWakes: number
  queue: string[]
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

const WAKE_PROMPT =
  'A terminal you are driving just parked, needs input, or exited. Here are the current terminal states — read_terminal any you need a closer look at, then drive them onward (or launch more CLIs). Call update_todo "review" only when the WHOLE todo is written and verified, or "failed" with a note if it cannot be done.'

/** Prompt for a FRESH executor session picking up a partially-done todo. Each
 *  loop iteration is a new session with a clean context window (not a retry), so
 *  it must be re-grounded in the state the previous sessions left on the todo:
 *  the worktree, the open terminals, and the plan. */
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
  if (todo.plan?.length) {
    const steps = todo.plan.map((s) => `${s.done ? '[x]' : '[ ]'} ${s.title}`).join('; ')
    lines.push(`Plan so far: ${steps}.`)
  }
  if (todo.note) lines.push(`Last note: ${todo.note}`)
  lines.push(
    `Finish the remaining work, then settle the todo: update_todo status "review" once it is written and verified${todo.branch ? ' and committed on the branch' : ''}, or "failed" with a short note if it cannot be done.`,
  )
  return lines.join(' ')
}

function executePrompt(todoId: string, title: string, hasWorktree: boolean): string {
  const cmd = loadPetExecutorAgentCommand()
  const launch = cmd
    ? `Launch the coding-agent CLI with \`${cmd}\` and give it the task as its prompt.`
    : 'Launch an installed coding-agent CLI (e.g. `claude`, `codex`, or `aider`) and give it the task as its prompt.'
  const where = hasWorktree
    ? 'An isolated worktree is ready; terminals run inside it, so have the agent commit on that branch.'
    : 'This is not a git repo, so there is no worktree; terminals run in the project root.'
  return [`Carry out this approved todo (id: ${todoId}): "${title}".`, where, launch].join(' ')
}

class PetController implements PetBridgeHost {
  private ws = new Map<string, WsRuntime>()
  private ctxByPanel = new Map<string, PetContext>()
  private tick: ReturnType<typeof setInterval> | null = null
  private started = false

  /** Wire the bridge + start the observe tick. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    console.info('[pet] controller started')
    setPetBridgeHost(this)
    // Expose for manual debugging from DevTools: __pet.observeNow(wsId).
    if (typeof window !== 'undefined') (window as unknown as { __pet?: unknown }).__pet = this
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
      r = { rootPath: rootPath ?? '', observerPanelId: null, dirty: false, lastObserveAt: 0, observerBusy: false, lastGitSig: null, runningTodoId: null, execContinuations: 0, execWakes: 0, queue: [], unsubGit: null }
      this.ws.set(wsId, r)
    }
    if (rootPath) r.rootPath = rootPath
    return r
  }

  // --- persistence + lifecycle controls -------------------------------------

  /** Read .cate/pet.json on workspace open; re-summon if it was enabled. */
  async restore(wsId: string, rootPath: string): Promise<void> {
    try {
      const state = await window.electronAPI.projectPetLoad(rootPath)
      // Mirror the persisted preference even when the pet stays dismissed, so the
      // Settings toggle reflects the saved choice the moment a workspace opens.
      usePetStore.getState().patch(wsId, { autoObserve: state.autoObserve })
      if (state.enabled) {
        await this.summon(wsId, rootPath, state.paused, state.autoObserve)
      }
    } catch (err) {
      log.warn('[petController] restore failed for %s: %O', wsId, err)
    }
  }

  private persist(wsId: string, rootPath: string): void {
    const p = usePetStore.getState().get(wsId)
    void window.electronAPI.projectPetSave(rootPath, { version: 1, enabled: p.enabled, paused: p.paused, autoObserve: p.autoObserve })
  }

  async summon(wsId: string, rootPath: string, paused = false, autoObserve?: boolean): Promise<void> {
    this.start()
    const r = this.rt(wsId, rootPath)
    // Load this workspace's todos before the observer can read or mutate them.
    // Otherwise propose_todo's upsert runs against an unloaded ([]) list and
    // persists OVER todos.json, wiping the user's existing tasks. Idempotent
    // with TasksView's own load (force-guarded).
    await useTodosStore.getState().loadTodos(rootPath)
    console.info('[pet] summon', wsId, rootPath)
    // Keep the current autoObserve preference unless the caller overrides it.
    const auto = autoObserve ?? usePetStore.getState().get(wsId).autoObserve
    usePetStore.getState().patch(wsId, { enabled: true, paused, autoObserve: auto, activity: paused ? 'paused' : 'resting', status: '' })
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
    const ctx: PetContext = { panelId, workspaceId: wsId, rootPath, role: 'observer' }
    this.ctxByPanel.set(panelId, ctx)
    const ok = await createPetSession({ panelId, rootPath, workspaceId: wsId, role: 'observer' })
    if (!ok) {
      this.ctxByPanel.delete(panelId)
      console.warn('[pet] observer session failed to start for', wsId)
      usePetStore.getState().patch(wsId, { status: 'Could not start (check provider sign-in)' })
      return
    }
    console.info('[pet] observer session started', panelId)
    r.observerPanelId = panelId
    this.markDirty(wsId) // prime a first look
  }

  /** Force one observe turn now (debug + manual nudge), bypassing the gate. */
  observeNow(wsId: string): void {
    const r = this.ws.get(wsId)
    if (!r?.observerPanelId) {
      console.warn('[pet] observeNow: no observer session for', wsId)
      return
    }
    console.info('[pet] observeNow', wsId)
    r.lastObserveAt = Date.now()
    void this.observe(wsId, r)
  }

  /** Take one observe turn: snapshot the workspace and prompt the observer with
   *  it injected, so it doesn't burn tool calls rediscovering known state. */
  private async observe(wsId: string, r: WsRuntime): Promise<void> {
    if (!r.observerPanelId) return
    const context = await buildObserveContext(wsId, r.rootPath)
    void promptPet(r.observerPanelId, `${OBSERVE_TURN_PROMPT}\n\n${context}`)
  }

  async dismiss(wsId: string, rootPath: string): Promise<void> {
    const r = this.ws.get(wsId)
    if (r) {
      if (r.observerPanelId) {
        void disposePet(r.observerPanelId)
        this.ctxByPanel.delete(r.observerPanelId)
      }
      if (r.runningTodoId) {
        const panelId = executorPanelId(r.runningTodoId)
        void disposePet(panelId)
        this.ctxByPanel.delete(panelId)
      }
      r.observerPanelId = null
      r.runningTodoId = null
      r.queue = []
      if (r.unsubGit) {
        r.unsubGit()
        r.unsubGit = null
      }
    }
    usePetStore.getState().patch(wsId, { enabled: false, paused: false, activity: 'off', status: '', remark: '', currentTodoId: null, focusNodeId: null })
    this.persist(wsId, rootPath)
  }

  pause(wsId: string, rootPath: string): void {
    const r = this.ws.get(wsId)
    usePetStore.getState().patch(wsId, { paused: true, activity: 'paused', status: 'Paused' })
    this.persist(wsId, rootPath)
    // Interrupt a running executor; observer simply holds (gate checks paused).
    if (r?.runningTodoId) void interruptPet(executorPanelId(r.runningTodoId))
  }

  resume(wsId: string, rootPath: string): void {
    usePetStore.getState().patch(wsId, { paused: false, activity: 'resting', status: '' })
    this.persist(wsId, rootPath)
    this.markDirty(wsId)
  }

  /** Toggle automatic observe turns. When turned back on, prime a look so the pet
   *  catches up on anything that changed while it was quiet. The manual nudge
   *  (clicking the idle pet) works regardless of this setting. */
  setAutoObserve(wsId: string, rootPath: string, value: boolean): void {
    usePetStore.getState().patch(wsId, { autoObserve: value })
    this.persist(wsId, rootPath)
    if (value) this.markDirty(wsId)
  }

  markDirty(wsId: string): void {
    const r = this.ws.get(wsId)
    if (r) r.dirty = true
  }

  // --- executor queue -------------------------------------------------------

  /** Start (or queue) execution of an approved/started todo. */
  async runTodo(wsId: string, rootPath: string, todoId: string): Promise<void> {
    this.start()
    const r = this.rt(wsId, rootPath)
    // Ensure todos are loaded before the executor reads/mutates them (summon
    // also loads, but an already-enabled pet skips summon here).
    await useTodosStore.getState().loadTodos(rootPath)
    const pet = usePetStore.getState().get(wsId)
    if (!pet.enabled) {
      // Allow "run with pet" to implicitly summon.
      await this.summon(wsId, rootPath)
    }
    if (r.runningTodoId || usePetStore.getState().get(wsId).paused) {
      if (!r.queue.includes(todoId)) r.queue.push(todoId)
      return
    }
    await this.startExecutor(wsId, rootPath, todoId)
  }

  private async startExecutor(wsId: string, rootPath: string, todoId: string): Promise<void> {
    const r = this.rt(wsId, rootPath)
    const todo = useTodosStore.getState().getTodos(rootPath).find((t) => t.id === todoId)
    if (!todo) return
    console.info('[pet] start executor', todoId, todo.title)
    r.runningTodoId = todoId
    r.execContinuations = 0
    r.execWakes = 0
    const panelId = executorPanelId(todoId)
    const ctx: PetContext = { panelId, workspaceId: wsId, rootPath, role: 'executor', todoId }
    this.ctxByPanel.set(panelId, ctx)
    useTodosStore.getState().setTodoStatus(rootPath, todoId, 'in_progress')
    usePetStore.getState().patch(wsId, { activity: 'working', currentTodoId: todoId, status: `Working: ${todo.title}` })
    // Prepare the isolated worktree deterministically before the agent runs (a
    // no-op for non-git workspaces, and idempotent so a todo gets only one).
    const { worktreeId } = await ensureTodoWorktree(wsId, rootPath, todoId)
    const ok = await createPetSession({ panelId, rootPath, workspaceId: wsId, role: 'executor' })
    if (!ok) {
      this.ctxByPanel.delete(panelId)
      r.runningTodoId = null
      useTodosStore.getState().patchTodo(rootPath, todoId, { status: 'failed', note: 'Could not start executor (check provider sign-in)' })
      usePetStore.getState().patch(wsId, { activity: 'resting', currentTodoId: null, status: '' })
      this.drainQueue(wsId, rootPath)
      return
    }
    void promptPet(panelId, executePrompt(todoId, todo.title, worktreeId !== null))
  }

  private finalizeExecutor(ctx: PetContext): void {
    // Idempotent: agent_end and the safety paths can both land here.
    if (!this.ctxByPanel.has(ctx.panelId)) return
    const r = this.ws.get(ctx.workspaceId)
    console.info('[pet] finalize executor', ctx.todoId)
    void disposePet(ctx.panelId)
    this.ctxByPanel.delete(ctx.panelId)
    if (r && r.runningTodoId === ctx.todoId) r.runningTodoId = null
    const stillEnabled = usePetStore.getState().get(ctx.workspaceId).enabled
    usePetStore.getState().patch(ctx.workspaceId, {
      activity: stillEnabled ? 'resting' : 'off',
      currentTodoId: null,
      focusNodeId: null,
      status: '',
    })
    this.markDirty(ctx.workspaceId) // a finished todo is a follow-up signal
    this.drainQueue(ctx.workspaceId, ctx.rootPath)
  }

  /** Loop iteration: replace the spent executor session with a FRESH one for the
   *  same todo and re-prompt it with the rebuilt state. The panelId is derived
   *  from the todoId, so re-creating it disposes the old pi session and starts a
   *  clean one (no transcript resume — a brand-new context window). */
  private async continueExecutor(ctx: PetContext): Promise<void> {
    const r = this.ws.get(ctx.workspaceId)
    if (!r || r.runningTodoId !== ctx.todoId) return // dismissed / superseded
    const todo = ctx.todoId ? useTodosStore.getState().getTodos(ctx.rootPath).find((t) => t.id === ctx.todoId) : undefined
    if (!todo) {
      this.finalizeExecutor(ctx)
      return
    }
    // Reuse the existing worktree (or create one if a prior session never got
    // far enough) so the continuation lands in the same isolated tree.
    await ensureTodoWorktree(ctx.workspaceId, ctx.rootPath, todo.id)
    const ok = await createPetSession({ panelId: ctx.panelId, rootPath: ctx.rootPath, workspaceId: ctx.workspaceId, role: 'executor' })
    if (!ok) {
      useTodosStore.getState().patchTodo(ctx.rootPath, todo.id, { status: 'failed', note: 'Could not start a follow-up executor session.' })
      this.finalizeExecutor(ctx)
      return
    }
    void promptPet(ctx.panelId, continuePrompt(todo))
  }

  private drainQueue(wsId: string, rootPath: string): void {
    const r = this.ws.get(wsId)
    if (!r || r.runningTodoId || usePetStore.getState().get(wsId).paused) return
    const next = r.queue.shift()
    if (next) void this.startExecutor(wsId, rootPath, next)
  }

  // --- observe tick ---------------------------------------------------------

  private onTick(): void {
    const now = Date.now()
    for (const [wsId, r] of this.ws) {
      const pet = usePetStore.getState().get(wsId)
      const todosForWs = useTodosStore.getState().getTodos(r.rootPath)
      const openSuggestions = todosForWs.filter((t) => t.status === 'suggested').length
      const fire = shouldObserve({
        enabled: pet.enabled,
        paused: pet.paused,
        autoObserve: pet.autoObserve,
        dirty: r.dirty,
        observerBusy: r.observerBusy,
        executorBusy: r.runningTodoId !== null,
        openSuggestions,
        lastObserveAt: r.lastObserveAt,
        now,
      })
      if (!fire || !r.observerPanelId) continue
      console.info('[pet] observe turn', wsId)
      r.dirty = false
      r.lastObserveAt = now
      void this.observe(wsId, r)
    }
  }

  // --- PetBridgeHost ---------------------------------------------------------

  contextFor(panelId: string): PetContext | null {
    return this.ctxByPanel.get(panelId) ?? null
  }

  onRunStart(ctx: PetContext): void {
    const r = this.ws.get(ctx.workspaceId)
    if (ctx.role === 'observer') {
      if (r) r.observerBusy = true
      const pet = usePetStore.getState().get(ctx.workspaceId)
      // Start each look from the corner; read_terminal moves the pet to whatever
      // it inspects, and a stale anchor (e.g. a since-closed terminal) is cleared.
      if (pet.activity === 'resting') usePetStore.getState().patch(ctx.workspaceId, { activity: 'observing', status: 'Looking around…', focusNodeId: null })
    } else {
      usePetStore.getState().patch(ctx.workspaceId, { activity: 'working' })
    }
  }

  onRunEnd(ctx: PetContext): void {
    const r = this.ws.get(ctx.workspaceId)
    if (ctx.role === 'observer') {
      if (r) r.observerBusy = false
      const pet = usePetStore.getState().get(ctx.workspaceId)
      if (pet.enabled && pet.activity === 'observing') {
        usePetStore.getState().patch(ctx.workspaceId, { activity: r?.runningTodoId ? 'working' : 'resting', status: '', focusNodeId: null })
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
      const paused = usePetStore.getState().get(ctx.workspaceId).paused
      if (!settled && !paused) {
        // Work still in flight → yield: wait (event-driven) for a terminal to park
        // or exit, then wake the SAME session — preserves orchestration context and
        // never busy-loops. Nothing running → the agent stalled, so re-ground it in
        // a FRESH session (clean context window), bounded by the continuation cap.
        if (todoHasBusyTerminal(ctx.workspaceId, ctx.rootPath, ctx.todoId)) {
          void this.scheduleWake(ctx)
          return
        }
        if (r.execContinuations < MAX_EXEC_CONTINUATIONS) {
          r.execContinuations += 1
          console.info('[pet] executor continue', ctx.todoId, r.execContinuations)
          void this.continueExecutor(ctx)
          return
        }
      }
    }
    this.settleStuckTodo(ctx)
  }

  /** Leave an unsettled todo in a clear, user-actionable state, then dispose the
   *  executor — never orphan an in_progress one. */
  private settleStuckTodo(ctx: PetContext): void {
    if (ctx.todoId) {
      const todo = useTodosStore.getState().getTodos(ctx.rootPath).find((t) => t.id === ctx.todoId)
      if (todo?.status === 'in_progress') {
        // Opened a terminal (started delegating) → hand the partial work to review;
        // otherwise it never started, so fail it so the user isn't left stuck.
        if (todo.terminalNodeIds?.length) {
          useTodosStore.getState().patchTodo(ctx.rootPath, ctx.todoId, {
            status: 'review',
            note: todo.note ?? 'Executor ended — review the partial work.',
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
  private async scheduleWake(ctx: PetContext): Promise<void> {
    if (!ctx.todoId) return
    await waitForTerminalSignal(ctx.workspaceId, ctx.rootPath, ctx.todoId)
    const r = this.ws.get(ctx.workspaceId)
    // Bail / settle if dismissed, superseded, paused, or already settled while we waited.
    if (!r || r.runningTodoId !== ctx.todoId) return
    const todo = useTodosStore.getState().getTodos(ctx.rootPath).find((t) => t.id === ctx.todoId)
    const settled = todo?.status === 'review' || todo?.status === 'failed' || todo?.status === 'done'
    if (settled || usePetStore.getState().get(ctx.workspaceId).paused || r.execWakes >= MAX_EXEC_WAKES) {
      this.settleStuckTodo(ctx)
      return
    }
    r.execWakes += 1
    console.info('[pet] executor wake', ctx.todoId, r.execWakes)
    void promptPet(ctx.panelId, `${WAKE_PROMPT}\n\n${buildExecutorContext(ctx.workspaceId, ctx.rootPath, ctx.todoId)}`)
  }

  onError(ctx: PetContext, message: string): void {
    log.warn('[petController] %s error: %s', ctx.panelId, message)
    if (ctx.role === 'executor' && ctx.todoId) {
      useTodosStore.getState().patchTodo(ctx.rootPath, ctx.todoId, { status: 'failed', note: message.slice(0, 200) })
      this.finalizeExecutor(ctx)
    } else {
      const r = this.ws.get(ctx.workspaceId)
      if (r) r.observerBusy = false
    }
  }
}

export const petController = new PetController()
