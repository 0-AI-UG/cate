// =============================================================================
// cateAgentController — the Cate Agent's brain (renderer, main window).
//
// Owns the headless sessions and their loops:
//   - Observer: an always-on session per workspace. A 60s tick consults the trigger
//     gate; when it passes the observer takes ONE turn and may remark into the
//     toolbar feed. It never mints a chat and never acts.
//   - Chat agent (the `orchestrator` role): ONE persistent session per chat, keyed by
//     chat id and retained across turns so it accumulates conversation history. You
//     type into a chat; its agent decides — answer inline (a `text` message), run a
//     code task as a LOOP (set a goal + check, spawn parallel ITERATIONS each in its
//     own worktree with a per-iteration driver, verify, pick a winner), or delegate a
//     canvas task. The loop machinery is unchanged; its state lives on the chat's
//     `run` and each agent action renders as a typed transcript block.
//   - Iteration check: when an iteration's work driver settles, the controller runs
//     the check through an independent VERIFIER driver, records the verdict, and wakes
//     the chat agent with it.
//
// The chat agent is event-driven: its tool calls mutate the chat's run/messages, then
// it ends its turn. The controller reconciles that state on each yield — running
// checks, waiting on iterations to settle, and waking the agent when work completes.
//
// The observer flag (.cate/cateAgent.json) is the only persisted controller state;
// chats persist via chatsStore. In-flight runs are NOT auto-resumed after a restart —
// restore() marks their orphaned runs `interrupted` so the block offers Continue.
// =============================================================================

import type { CateAgentActivity, ChatMessage, ChatRun } from '../../shared/types'
import type { CateAgentBridgeHost, CateAgentContext } from './cateAgentTypes'
import { setCateAgentBridgeHost } from './cateAgentBridge'
import {
  observerPanelId,
  orchestratorPanelId,
  createCateAgentSession,
  promptCateAgent,
  interruptCateAgent,
  disposeCateAgent,
} from './cateAgentSession'
import { shouldObserve } from './cateAgentTriggerGate'
import { setContext, getContext, deleteContext, hasContext, contextPanelIds } from './cateAgentContextRegistry'
import { signalRunEnd } from './cateAgentRunWaiters'
import {
  buildObserveContext,
  buildRunContext,
  waitForIterationsSettled,
  patchIteration,
  runIterationCheck,
} from './cateAgentTools'
import { teardownRunWork } from './cateAgentReviewActions'
import { getWorkspaceCanvasPanelId } from '../lib/workspace/canvasAccess'
import { useCateAgentStore } from './cateAgentStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useChatsStore } from '../stores/chatsStore'
import { generateId } from '../stores/canvas/helpers'
import { workspaceIdForTerminal } from '../stores/statusStore'
import { gitStatusStore } from '../stores/gitStatusStore'
import log from '../lib/logger'

/** Per-run state (wake bounding). One entry per chat with a turn/loop in flight —
 *  its presence in WsRuntime.runs means that chat's agent is active. */
interface RunState {
  /** Decision wakes (iterations finished / verdicts in) on this run. */
  wakes: number
  /** True while the chat session is mid-turn — don't wake it then. */
  busy: boolean
  /** Monotonic run token, mirrored from the chat's persistent ctx.epoch. A run can be
   *  stopped + continued reusing the same chatId/panelId; the epoch lets an in-flight
   *  reconcile from the old run detect it was superseded and bail. */
  epoch: number
}

interface WsRuntime {
  rootPath: string
  observerPanelId: string | null
  dirty: boolean
  lastObserveAt: number
  observerBusy: boolean
  lastGitSig: string | null
  /** Active chat runs keyed by chatId — multiple run concurrently. */
  runs: Map<string, RunState>
  /** Chats with a live persistent agent session, keyed by chatId. */
  sessions: Set<string>
  unsubGit: (() => void) | null
}

const OBSERVE_TICK_MS = 60_000

/** The user-set gap between automatic observe turns (Settings → Cate Agent),
 *  floored at one tick. */
function observeCooldownMs(): number {
  const min = useSettingsStore.getState().cateAgentObserveCooldownMin
  return Math.max(1, Number(min) || 1) * 60_000
}

/** Max decision wakes (a flapping loop), far above any real run. */
const MAX_WAKES = 60

function gitSignature(snap: { branch?: string | null; statusFiles: Array<{ path: string; index: string; working_dir: string }> }): string {
  const files = snap.statusFiles.map((f) => `${f.path}|${f.index}${f.working_dir}`).join(',')
  return `${snap.branch ?? ''}::${files}`
}

const OBSERVE_TURN_PROMPT =
  'Workspace state below. read_terminal anything worth a look, then remark.'

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

const SETTLED: ReadonlyArray<ChatRun['status']> = ['review', 'done', 'failed']
const isSettled = (s: ChatRun['status'] | undefined): boolean => !!s && SETTLED.includes(s)

function getRun(rootPath: string, chatId: string): ChatRun | undefined {
  return useChatsStore.getState().getRun(rootPath, chatId)
}

function chatTitle(rootPath: string, chatId: string): string {
  return useChatsStore.getState().getChat(rootPath, chatId)?.title ?? 'this task'
}

function textMessage(role: 'user' | 'agent', text: string): ChatMessage {
  return { id: `msg-${generateId()}`, role, ts: Date.now(), kind: 'text', text }
}

class CateAgentController implements CateAgentBridgeHost {
  private ws = new Map<string, WsRuntime>()
  private tick: ReturnType<typeof setInterval> | null = null
  private started = false
  private epochSeq = 0
  /** No AI provider connected → the agent can't reach a model, so every loop
   *  entry point below no-ops. App.tsx flips this from provider readiness. */
  private providersReady = false

  /** Enable/disable all Cate Agent activity based on whether a working provider
   *  exists. When disabled, observation ticks, summon, observeNow and sendMessage are
   *  no-ops (existing runs are left alone). App.tsx (re)runs restore() when this
   *  flips true so the observer session comes up once a provider connects. */
  setEnabled(ready: boolean): void {
    this.providersReady = ready
  }

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
      r = { rootPath: rootPath ?? '', observerPanelId: null, dirty: false, lastObserveAt: 0, observerBusy: false, lastGitSig: null, runs: new Map(), sessions: new Set(), unsubGit: null }
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
      // The Cate Agent is always on — restore only recovers the autoObserve choice.
      await this.summon(wsId, rootPath, state.autoObserve)
    } catch (err) {
      log.warn('[cateAgentController] restore failed for %s: %O', wsId, err)
    }
  }

  /** Settle chat runs left `running` by a previous session that has no live run: a
   *  run with worktree-bearing iterations goes to review (inspect/land), the rest
   *  fail. Marked `interrupted` so the transcript block offers Continue. Idempotent. */
  private async reconcileOrphans(rootPath: string): Promise<void> {
    await useChatsStore.getState().loadChats(rootPath)
    const hasLiveRun = (id: string): boolean => [...this.ws.values()].some((r) => r.runs.has(id))
    for (const c of useChatsStore.getState().getChats(rootPath)) {
      if (c.run?.status === 'running' && !hasLiveRun(c.id)) {
        const passed = c.run.iterations?.find((i) => i.status === 'passed' && i.worktreeId)
        useChatsStore.getState().patchRun(rootPath, c.id, {
          status: passed ? 'review' : c.run.worktreeId ? 'review' : 'failed',
          ...(passed ? { worktreeId: passed.worktreeId, branch: passed.branch } : {}),
          note: 'Interrupted — the app was restarted.',
          interrupted: true,
        })
      }
    }
  }

  private persist(wsId: string, rootPath: string): void {
    const p = useCateAgentStore.getState().get(wsId)
    void window.electronAPI.projectCateAgentSave(rootPath, { version: 1, autoObserve: p.autoObserve })
  }

  async summon(wsId: string, rootPath: string, autoObserve?: boolean): Promise<void> {
    if (!this.providersReady) return
    this.start()
    const r = this.rt(wsId, rootPath)
    await useChatsStore.getState().loadChats(rootPath)
    console.info('[cateAgent] summon', wsId, rootPath)
    const auto = autoObserve ?? useCateAgentStore.getState().get(wsId).autoObserve
    useCateAgentStore.getState().patch(wsId, { autoObserve: auto, activity: 'resting', status: '' })
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
    if (!this.providersReady) return
    const r = this.ws.get(wsId)
    if (!r?.observerPanelId) {
      console.warn('[cateAgent] observeNow: no observer session for', wsId)
      return
    }
    r.lastObserveAt = Date.now()
    void this.observe(wsId, r)
  }

  /** Send a user message into a chat — append it to the transcript and run the chat's
   *  persistent agent (creating its session on the first message, continuing the same
   *  history-bearing session after). The agent decides how to respond. */
  async sendMessage(wsId: string, rootPath: string, chatId: string, text: string): Promise<void> {
    if (!this.providersReady) return
    const trimmed = text.trim()
    if (!trimmed) return
    this.start()
    const r = this.rt(wsId, rootPath)
    await useChatsStore.getState().loadChats(rootPath)
    if (!r.observerPanelId) await this.summon(wsId, rootPath)
    const chat = useChatsStore.getState().getChat(rootPath, chatId)
    if (!chat) return
    useChatsStore.getState().appendMessage(rootPath, chatId, textMessage('user', trimmed))

    const panelId = orchestratorPanelId(chatId)
    const canvasPanelId = chat.run?.canvasPanelId ?? getWorkspaceCanvasPanelId(wsId) ?? undefined
    if (!r.sessions.has(chatId) || !hasContext(panelId)) {
      const ctx: CateAgentContext = { panelId, workspaceId: wsId, rootPath, role: 'orchestrator', chatId, epoch: ++this.epochSeq, canvasPanelId }
      setContext(panelId, ctx)
      const ok = await createCateAgentSession({ panelId, rootPath, workspaceId: wsId, role: 'orchestrator' })
      if (!ok) {
        deleteContext(panelId)
        r.sessions.delete(chatId)
        useChatsStore.getState().appendMessage(rootPath, chatId, textMessage('agent', 'Could not start the agent (check provider sign-in).'))
        return
      }
      r.sessions.add(chatId)
    }
    // Refresh the run token for this turn (resets the wake budget) and mirror it onto
    // the persistent ctx so reconciles/wakes for this turn match.
    const ctx = getContext(panelId)!
    const epoch = ++this.epochSeq
    ctx.epoch = epoch
    if (canvasPanelId && !ctx.canvasPanelId) ctx.canvasPanelId = canvasPanelId
    r.runs.set(chatId, { wakes: 0, busy: false, epoch })
    useCateAgentStore.getState().patch(wsId, { activity: 'working', status: pick(WORKING_STATUSES)(chat.title) })
    void promptCateAgent(panelId, trimmed)
  }

  /** Continue an interrupted run (the Continue block action): wipe the dead
   *  iteration layer, then re-ground the chat's agent in the current run state. */
  async continueRun(wsId: string, rootPath: string, chatId: string): Promise<void> {
    if (!this.providersReady) return
    this.start()
    const r = this.rt(wsId, rootPath)
    await useChatsStore.getState().loadChats(rootPath)
    if (!r.observerPanelId) await this.summon(wsId, rootPath)
    const run = getRun(rootPath, chatId)
    if (!run) return
    useChatsStore.getState().patchRun(rootPath, chatId, { interrupted: false, note: undefined, status: 'running' })
    await this.clearRunWork(wsId, rootPath, chatId)
    const panelId = orchestratorPanelId(chatId)
    const canvasPanelId = run.canvasPanelId ?? getWorkspaceCanvasPanelId(wsId) ?? undefined
    if (!r.sessions.has(chatId) || !hasContext(panelId)) {
      const ctx: CateAgentContext = { panelId, workspaceId: wsId, rootPath, role: 'orchestrator', chatId, epoch: ++this.epochSeq, canvasPanelId }
      setContext(panelId, ctx)
      const ok = await createCateAgentSession({ panelId, rootPath, workspaceId: wsId, role: 'orchestrator' })
      if (!ok) {
        deleteContext(panelId)
        useChatsStore.getState().patchRun(rootPath, chatId, { status: 'failed', note: 'Could not restart the agent (check provider sign-in).' })
        return
      }
      r.sessions.add(chatId)
    }
    const ctx = getContext(panelId)!
    const epoch = ++this.epochSeq
    ctx.epoch = epoch
    if (canvasPanelId && !ctx.canvasPanelId) ctx.canvasPanelId = canvasPanelId
    r.runs.set(chatId, { wakes: 0, busy: false, epoch })
    useCateAgentStore.getState().patch(wsId, { activity: 'working', status: pick(WORKING_STATUSES)(chatTitle(rootPath, chatId)) })
    const prompt = [
      'Continue this task. State below — don\'t restart finished work.',
      'If it has a goal, stay in the loop: select_winner a passer, iterate again folding in failures, or fail with a reason. Otherwise finish and end your turn.',
      `\n\n${buildRunContext(wsId, rootPath, chatId)}`,
    ].join(' ')
    void promptCateAgent(panelId, prompt)
  }

  /** Stop a chat's in-flight run: interrupt the turn, tear down its iteration layer
   *  (worktrees + terminals + branch), and mark the run failed. The chat session is
   *  kept alive so the user can keep chatting. */
  stop(wsId: string, chatId: string): void {
    const r = this.ws.get(wsId)
    if (!r) return
    const rootPath = r.rootPath
    void interruptCateAgent(orchestratorPanelId(chatId))
    r.runs.delete(chatId)
    this.disposeDriverSessions(chatId)
    const run = getRun(rootPath, chatId)
    if (run) {
      void teardownRunWork(wsId, rootPath, run, { deleteBranch: true })
      if (run.status === 'running') {
        useChatsStore.getState().patchRun(rootPath, chatId, {
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

  /** Close a chat: dispose its session, tear down any run work, and remove it. */
  async closeChat(wsId: string, rootPath: string, chatId: string): Promise<void> {
    const r = this.rt(wsId, rootPath)
    r.runs.delete(chatId)
    r.sessions.delete(chatId)
    this.disposeDriverSessions(chatId)
    const run = getRun(rootPath, chatId)
    if (run) await teardownRunWork(wsId, rootPath, run, { deleteBranch: true })
    await disposeCateAgent(orchestratorPanelId(chatId))
    deleteContext(orchestratorPanelId(chatId))
    useChatsStore.getState().removeChat(rootPath, chatId)
    this.syncActivity(wsId)
  }

  /** Dispose the per-iteration DRIVER sessions for this chat (not the persistent chat
   *  session). Deleting the driver's context then signalling its run waiter lets a
   *  parked runDriverToCompletion loop wake and bail immediately. */
  private disposeDriverSessions(chatId: string): void {
    const keepPanelId = orchestratorPanelId(chatId)
    for (const panelId of contextPanelIds()) {
      if (panelId === keepPanelId) continue
      const ctx = getContext(panelId)
      if (!ctx || ctx.chatId !== chatId) continue
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
    const activity: CateAgentActivity = anyRun ? 'working' : r.observerBusy ? 'observing' : 'resting'
    useCateAgentStore.getState().patch(wsId, { activity, status: anyRun ? cur.status : '' })
  }

  // --- run cleanup ----------------------------------------------------------

  /** Remove every worktree + terminal a prior run of this chat left behind (and its
   *  branch) and clear the now-dead iteration-layer refs. The goal + check survive so
   *  a continue can re-ground; only the iteration layer is wiped. */
  private async clearRunWork(wsId: string, rootPath: string, chatId: string): Promise<void> {
    const run = getRun(rootPath, chatId)
    if (!run) return
    await teardownRunWork(wsId, rootPath, run, { deleteBranch: true })
    useChatsStore.getState().patchRun(rootPath, chatId, {
      worktreeId: undefined,
      branch: undefined,
      iterations: undefined,
      round: undefined,
      recommendedIterationId: undefined,
      terminalNodeIds: undefined,
    })
  }

  /** Tear down the run bookkeeping: dispose the run's driver sessions, drop its
   *  terminals from the glow set, freeze the attempts snapshot. The chat's persistent
   *  agent session is left alive. */
  private finalizeRun(ctx: CateAgentContext): void {
    if (!ctx.chatId) return
    const r = this.ws.get(ctx.workspaceId)
    console.info('[cateAgent] finalize run', ctx.chatId)
    this.disposeDriverSessions(ctx.chatId)
    if (r) r.runs.delete(ctx.chatId)
    const run = getRun(ctx.rootPath, ctx.chatId)
    this.freezeAttempts(ctx.rootPath, ctx.chatId)
    for (const tid of run?.terminalNodeIds ?? []) useCateAgentStore.getState().removeControlledTerminal(ctx.workspaceId, tid)
    useCateAgentStore.getState().clearRunAnchor(ctx.workspaceId, ctx.chatId)
    this.syncActivity(ctx.workspaceId)
    this.markDirty(ctx.workspaceId)
  }

  /** Copy the run's live iteration grid into its attempts message so the frozen
   *  transcript still means something after a reload. */
  private freezeAttempts(rootPath: string, chatId: string): void {
    const run = getRun(rootPath, chatId)
    if (!run?.attemptsMessageId) return
    useChatsStore.getState().patchMessage(rootPath, chatId, run.attemptsMessageId, {
      iterations: run.iterations ?? [],
      round: run.round,
      recommendedIterationId: run.recommendedIterationId,
    })
  }

  // --- the reconciler -------------------------------------------------------

  /** Advance one chat run from the current run/iteration state. Called on the agent's
   *  yield (agent_end) and whenever a checker it depends on finishes. Waits on
   *  iteration terminals, runs the per-iteration checks, and wakes the agent when work
   *  it cares about completes. */
  private async reconcile(ctx: CateAgentContext): Promise<void> {
    const r = this.ws.get(ctx.workspaceId)
    if (!r || !ctx.chatId || r.runs.get(ctx.chatId)?.epoch !== ctx.epoch) return // superseded
    const run = r.runs.get(ctx.chatId)!
    if (run.busy) return // agent mid-turn; its agent_end will reconcile
    const chatRun = getRun(ctx.rootPath, ctx.chatId)
    if (!chatRun || isSettled(chatRun.status)) {
      this.finalizeRun(ctx)
      return
    }

    const round = chatRun.round ?? 0
    const iters = (chatRun.iterations ?? []).filter((i) => i.round === round)

    // (A) Iterations still running. Each one's per-iteration driver flips it to
    //     `finished`/`error` when it settles; wait for that, then re-reconcile.
    const running = iters.filter((i) => i.status === 'running')
    if (running.length) {
      await waitForIterationsSettled(ctx.rootPath, running.map((i) => i.id))
      if (r.runs.get(ctx.chatId)?.epoch !== ctx.epoch) return
      return this.reconcile(ctx)
    }

    // (B) Finished iterations need checking. Kick a checker for each (it flips the
    //     iteration to 'verifying' and re-reconciles with a verdict).
    const finished = iters.filter((i) => i.status === 'finished')
    if (finished.length) {
      for (const it of finished) void this.runChecker(ctx, it.id)
      return
    }

    // (C) Checks in flight — wait for their verdicts to re-reconcile.
    if (iters.some((i) => i.status === 'verifying')) return

    // (D) Nothing in flight, unsettled — the agent has verdicts to act on. Wake it.
    this.wakeOrchestrator(ctx)
  }

  /** Run the goal check for one finished iteration via an independent verifier driver,
   *  then record its verdict and re-reconcile. Flips the iteration to 'verifying'
   *  synchronously so re-entrant reconciles don't double-launch it. */
  private async runChecker(ctx: CateAgentContext, iterationId: string): Promise<void> {
    const r = this.ws.get(ctx.workspaceId)
    if (!r || !ctx.chatId || r.runs.get(ctx.chatId)?.epoch !== ctx.epoch) return
    const run = getRun(ctx.rootPath, ctx.chatId)
    const iteration = run?.iterations?.find((i) => i.id === iterationId)
    if (!run || !iteration || iteration.status !== 'finished') return
    patchIteration(ctx.rootPath, ctx.chatId, iterationId, { status: 'verifying' })
    const verdict = await runIterationCheck(ctx.workspaceId, ctx.rootPath, ctx.chatId, iteration)
    if (r.runs.get(ctx.chatId)?.epoch !== ctx.epoch) return // superseded mid-check
    patchIteration(ctx.rootPath, ctx.chatId, iterationId, {
      status: verdict.met ? 'passed' : 'failed',
      verify: {
        met: verdict.met,
        reason: verdict.reason,
        at: Date.now(),
        ...(verdict.checks ? { checks: verdict.checks } : {}),
        ...(verdict.suggestion ? { suggestion: verdict.suggestion } : {}),
      },
    })
    void this.reconcile(ctx)
  }

  /** Wake the SAME chat session with the current loop state, so it verifies finished
   *  iterations or decides on verdicts. Caps wakes; on overflow it auto-settles
   *  (review the first passing iteration, else fail). */
  private wakeOrchestrator(ctx: CateAgentContext): void {
    const r = this.ws.get(ctx.workspaceId)
    if (!r || !ctx.chatId) return
    const run = r.runs.get(ctx.chatId)
    if (!run || run.epoch !== ctx.epoch) return
    const chatRun = getRun(ctx.rootPath, ctx.chatId)
    if (!chatRun) {
      this.finalizeRun(ctx)
      return
    }
    if (run.wakes >= MAX_WAKES) {
      this.settleByVerdict(ctx, chatRun, 'Stopped looping — too many rounds without a clear winner.')
      return
    }
    run.wakes += 1
    const prompt = [
      'Loop state below. select_winner a passer, iterate again folding in failures, or fail with a reason.',
      `\n\n${buildRunContext(ctx.workspaceId, ctx.rootPath, ctx.chatId)}`,
    ].join('')
    void promptCateAgent(ctx.panelId, prompt)
  }

  /** Complete a chat turn that produced no goal (a question / canvas / read-only task):
   *  its final assistant message becomes an inline `text` block. Turn-end IS completion
   *  for these — there's no code loop to settle. The session stays alive for follow-ups. */
  private completeSimpleTurn(ctx: CateAgentContext, finalText?: string): void {
    if (!ctx.chatId) return
    const output = (finalText ?? '').trim()
    if (output) useChatsStore.getState().appendMessage(ctx.rootPath, ctx.chatId, textMessage('agent', output))
    // Drop the run bookkeeping, but KEEP a run that still holds an unlanded worktree
    // (a code task in review): its result block needs the worktree/branch for the land
    // actions. A question/canvas/failed turn has nothing to land, so its run is cleared.
    this.finalizeRun(ctx)
    if (!getRun(ctx.rootPath, ctx.chatId)?.worktreeId) useChatsStore.getState().clearRun(ctx.rootPath, ctx.chatId)
  }

  /** Auto-settle a run that can't progress: review the first passing iteration if any,
   *  else fail. */
  private settleByVerdict(ctx: CateAgentContext, run: ChatRun, note: string): void {
    if (!ctx.chatId) return
    const passed = run.iterations?.find((i) => i.status === 'passed' && i.worktreeId)
    useChatsStore.getState().patchRun(ctx.rootPath, ctx.chatId, {
      status: passed ? 'review' : 'failed',
      ...(passed ? { worktreeId: passed.worktreeId, branch: passed.branch, recommendedIterationId: passed.id } : {}),
      note,
    })
    this.finalizeRun(ctx)
  }

  // --- observe tick ---------------------------------------------------------

  private onTick(): void {
    if (!this.providersReady) return
    const now = Date.now()
    for (const [wsId, r] of this.ws) {
      const cateAgent = useCateAgentStore.getState().get(wsId)
      const fire = shouldObserve({
        autoObserve: cateAgent.autoObserve,
        dirty: r.dirty,
        observerBusy: r.observerBusy,
        orchestratorBusy: r.runs.size > 0,
        openSuggestions: 0,
        lastObserveAt: r.lastObserveAt,
        now,
        cooldownMs: observeCooldownMs(),
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
    // Per-iteration drivers and ephemeral canvas subagents are owned by their own
    // launchers; they don't drive the observe/chat loops or the global activity state.
    if (ctx.role === 'driver' || ctx.role === 'canvas') return
    const r = this.ws.get(ctx.workspaceId)
    if (ctx.role === 'observer') {
      if (r) r.observerBusy = true
      const cateAgent = useCateAgentStore.getState().get(ctx.workspaceId)
      if (cateAgent.activity === 'resting') useCateAgentStore.getState().patch(ctx.workspaceId, { activity: 'observing', status: pick(OBSERVING_STATUSES) })
      return
    }
    if (ctx.role === 'orchestrator' && r && ctx.chatId) {
      const run = r.runs.get(ctx.chatId)
      if (run && run.epoch === ctx.epoch) run.busy = true
    }
    useCateAgentStore.getState().patch(ctx.workspaceId, { activity: 'working' })
  }

  onRunEnd(ctx: CateAgentContext, finalText?: string): void {
    // A driver/canvas run ending is the settle signal their launcher awaits (via the
    // bridge's signalRunEnd); that launcher owns dispose + cleanup, so nothing here.
    if (ctx.role === 'driver' || ctx.role === 'canvas') return
    const r = this.ws.get(ctx.workspaceId)
    if (ctx.role === 'observer') {
      if (r) r.observerBusy = false
      const cateAgent = useCateAgentStore.getState().get(ctx.workspaceId)
      if (cateAgent.activity === 'observing') {
        useCateAgentStore.getState().patch(ctx.workspaceId, { activity: r && r.runs.size > 0 ? 'working' : 'resting', status: '' })
      }
      return
    }
    // Chat agent yielded.
    if (ctx.chatId && r) {
      const run = r.runs.get(ctx.chatId)
      if (run && run.epoch === ctx.epoch) run.busy = false
      else return // superseded
      const chatRun = getRun(ctx.rootPath, ctx.chatId)
      // A turn that launched/queued work leaves iterations pending — reconcile drives them.
      if (this.hasPendingWork(ctx.rootPath, ctx.chatId)) {
        void this.reconcile(ctx)
        return
      }
      // Mid code-loop (goal set, still running) with nothing pending → a decision is
      // due; wake the agent (bounded) to select_winner / iterate / fail. NOTE the
      // status test: a run that already settled to review/done/failed (this turn's
      // select_winner/fail, OR a lingering prior task) is NOT a live loop — it falls
      // through to completeSimpleTurn, which finalizes and records the closing message.
      if (chatRun?.goal && chatRun.status === 'running') {
        this.wakeOrchestrator(ctx)
        return
      }
      // Otherwise this turn was (or ended as) a plain answer / canvas / read-only — its
      // final message becomes an inline text block and the run bookkeeping is retired.
      this.completeSimpleTurn(ctx, finalText)
      return
    }
    if (ctx.chatId) this.finalizeRun(ctx)
  }

  /** Is the chat run waiting on something the controller drives — a running, finished
   *  (awaiting check), or verifying iteration? */
  private hasPendingWork(rootPath: string, chatId: string): boolean {
    const run = getRun(rootPath, chatId)
    if (!run) return false
    const round = run.round ?? 0
    return (run.iterations ?? []).some((i) => i.round === round && (i.status === 'running' || i.status === 'verifying' || i.status === 'finished'))
  }

  onError(ctx: CateAgentContext, message: string): void {
    log.warn('[cateAgentController] %s error: %s', ctx.panelId, message)
    if (ctx.role === 'driver' || ctx.role === 'canvas') return // launcher owns cleanup
    if (ctx.role === 'orchestrator' && ctx.chatId) {
      // Bail if this run was superseded. Stop + resend replaces r.runs[chatId]
      // with a fresh epoch; patching/finalizing on the stale epoch would mark the
      // live turn failed and delete the NEW run's bookkeeping (finalizeRun deletes
      // r.runs[chatId]). Mirrors the epoch guard onRunStart/onRunEnd already use.
      const active = this.ws.get(ctx.workspaceId)?.runs.get(ctx.chatId)
      if (!active || active.epoch !== ctx.epoch) return
      useChatsStore.getState().appendMessage(ctx.rootPath, ctx.chatId, textMessage('agent', `Error: ${message.slice(0, 200)}`))
      const run = getRun(ctx.rootPath, ctx.chatId)
      if (run) useChatsStore.getState().patchRun(ctx.rootPath, ctx.chatId, { status: 'failed', note: message.slice(0, 200) })
      this.finalizeRun(ctx)
    } else {
      const r = this.ws.get(ctx.workspaceId)
      if (r) r.observerBusy = false
    }
  }
}

export const cateAgentController = new CateAgentController()
