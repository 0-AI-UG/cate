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
  queue: string[]
  /** unsubscribe from this workspace's git-status dirty source */
  unsubGit: (() => void) | null
}

const OBSERVE_TICK_MS = 60_000

/** A content signature of the working tree, so window-focus / poll refreshes that
 *  don't actually change anything don't count as "the user did something". */
function gitSignature(snap: { branch?: string | null; statusFiles: Array<{ path: string; index: string; working_dir: string }> }): string {
  const files = snap.statusFiles.map((f) => `${f.path}|${f.index}${f.working_dir}`).join(',')
  return `${snap.branch ?? ''}::${files}`
}

const OBSERVE_TURN_PROMPT =
  'Take a look at what the user is doing right now. Use get_user_activity, list_terminals/read_terminal, and list_todos. If — and ONLY if — there is a clearly valuable, specific, non-duplicate task worth doing, call propose_todo with a concise rationale. Otherwise do nothing and end your turn.'

function executePrompt(todoId: string, title: string): string {
  const cmd = loadPetExecutorAgentCommand()
  const launch = cmd
    ? `Launch the coding-agent CLI by running \`${cmd}\` in the terminal, then give it the task as its prompt.`
    : 'Launch an installed coding-agent CLI in the terminal (e.g. `claude`, `codex`, or `aider`) and give it the task as its prompt.'
  return [
    `Orchestrate this approved todo (id: ${todoId}): "${title}".`,
    'You are a PURE ORCHESTRATOR — do NOT do any of the work yourself. A coding-agent CLI in a terminal does everything.',
    'Steps: (1) create_worktree. (2) set_plan with a short plan.',
    `(3) create_terminal in the worktree. ${launch}`,
    '(4) Drive and monitor it with send_keys / wait_for_terminal / read_terminal until it has written the change AND verified it (and committed on the worktree branch).',
    '(5) update_todo status "review" once it is done. If it cannot be completed, update_todo status "failed" with a short note. Never write files or run build/test commands yourself.',
  ].join(' ')
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
      r = { rootPath: rootPath ?? '', observerPanelId: null, dirty: false, lastObserveAt: 0, observerBusy: false, lastGitSig: null, runningTodoId: null, queue: [], unsubGit: null }
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
      if (state.enabled) {
        await this.summon(wsId, rootPath, state.paused)
      }
    } catch (err) {
      log.warn('[petController] restore failed for %s: %O', wsId, err)
    }
  }

  private persist(wsId: string, rootPath: string): void {
    const p = usePetStore.getState().get(wsId)
    void window.electronAPI.projectPetSave(rootPath, { version: 1, enabled: p.enabled, paused: p.paused })
  }

  async summon(wsId: string, rootPath: string, paused = false): Promise<void> {
    this.start()
    const r = this.rt(wsId, rootPath)
    console.info('[pet] summon', wsId, rootPath)
    usePetStore.getState().patch(wsId, { enabled: true, paused, activity: paused ? 'paused' : 'resting', status: '' })
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
    void promptPet(r.observerPanelId, OBSERVE_TURN_PROMPT)
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
    usePetStore.getState().patch(wsId, { enabled: false, paused: false, activity: 'off', status: '', currentTodoId: null, focusNodeId: null })
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

  markDirty(wsId: string): void {
    const r = this.ws.get(wsId)
    if (r) r.dirty = true
  }

  // --- executor queue -------------------------------------------------------

  /** Start (or queue) execution of an approved/started todo. */
  async runTodo(wsId: string, rootPath: string, todoId: string): Promise<void> {
    this.start()
    const r = this.rt(wsId, rootPath)
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
    const panelId = executorPanelId(todoId)
    const ctx: PetContext = { panelId, workspaceId: wsId, rootPath, role: 'executor', todoId }
    this.ctxByPanel.set(panelId, ctx)
    useTodosStore.getState().setTodoStatus(rootPath, todoId, 'in_progress')
    usePetStore.getState().patch(wsId, { activity: 'working', currentTodoId: todoId, status: `Working: ${todo.title}` })
    const ok = await createPetSession({ panelId, rootPath, workspaceId: wsId, role: 'executor' })
    if (!ok) {
      this.ctxByPanel.delete(panelId)
      r.runningTodoId = null
      useTodosStore.getState().patchTodo(rootPath, todoId, { status: 'failed', note: 'Could not start executor (check provider sign-in)' })
      usePetStore.getState().patch(wsId, { activity: 'resting', currentTodoId: null, status: '' })
      this.drainQueue(wsId, rootPath)
      return
    }
    void promptPet(panelId, executePrompt(todoId, todo.title))
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
      void promptPet(r.observerPanelId, OBSERVE_TURN_PROMPT)
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
    // Executor turn ended (one prompt → one turn). Leave the todo in a clear,
    // user-actionable state before disposing the session — never orphan it.
    if (ctx.todoId) {
      const todo = useTodosStore.getState().getTodos(ctx.rootPath).find((t) => t.id === ctx.todoId)
      const status = todo?.status
      if (status === 'in_progress') {
        // The executor stopped without explicitly finishing. If it got far enough
        // to create a worktree, hand the partial work to the review gate;
        // otherwise mark it failed so the user isn't left with a stuck task.
        if (todo?.worktreeId) {
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
