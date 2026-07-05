// =============================================================================
// codingAgentLauncher — "run a driver to completion", the single primitive used by
// BOTH a work iteration and the verifier.
//
// One DRIVER session per iteration (headless, event-driven). It is seeded with the
// iteration's overview + worktree cwd, decides how to decompose the work into one
// or more terminal coding agents, and drives them with create_terminal + send_keys:
//   - create_terminal opens a BARE shell in the worktree.
//   - send_keys types the CLI launch command, answers trust/permission prompts,
//     then submits the task with background:true and the driver ends its turn.
//   - background:true ARMS a one-shot wake: when that terminal's coding-agent turn
//     completes, the OWNING driver is re-prompted with the terminal's final screen
//     (the Claude-Code background-task pattern). An interactive CLI stays alive at
//     its prompt between turns, so "turn complete" is running -> waitingForInput
//     (NOT `finished`, which only means the CLI process exited). The wake is gated
//     on the agent having actually RUN since arming, so the trust/permission prompts
//     answered during launch (waitingForInput with no run yet) don't wake the driver
//     prematurely.
//
// "Settled" = a driver run ends with NO outstanding background send_keys. That is
// the iteration's execution-done signal; runDriverToCompletion resolves there. The
// driver's own messages never reach the orchestrator — we only need the signal.
// =============================================================================

import { loadCateAgentOrchestratorAgentCommand } from '../../agent/renderer/agentModelPrefs'
import { createCateAgentSession, promptCateAgent, disposeCateAgent, driverPanelId } from './cateAgentSession'
import {
  setContext,
  deleteContext,
  hasContext,
  setTerminalOwner,
  terminalOwner,
  terminalsOwnedBy,
  clearTerminalOwner,
} from './cateAgentContextRegistry'
import {
  awaitRunEnd,
  incDriverOutstanding,
  decDriverOutstanding,
  driverOutstanding,
  clearDriverOutstanding,
} from './cateAgentRunWaiters'
import { ptyFor, agentStateFor, activityRunning, readTerminalState, openTerminal, shortId } from './cateAgentTerminals'
import type { AgentTerminalSlot } from './cateAgentPlacement'
import { useTodosStore } from '../stores/todosStore'
import { useStatusStore } from '../stores/statusStore'
import type { AgentState } from '../../shared/types'
import type { CateAgentContext } from './cateAgentTypes'
import log from '../lib/logger'

/** Overall wall-clock backstop for a single driver. A run's own turns are short
 *  (it pokes terminals and stops); the long waits are BETWEEN runs, parked until a
 *  terminal finishes and the wake re-prompts. This bounds a terminal that hangs. */
const DRIVER_SETTLE_TIMEOUT_MS = 30 * 60_000

// --- backgrounded-send_keys wake -------------------------------------------
//
// A statusStore subscription plus a slow timer, both live only while wakes are
// armed, watch each armed terminal and re-prompt the owning driver. A backgrounded
// send_keys is usually a coding-agent CLI, but may be a plain long-running command
// (a build, a test run) — so we watch BOTH signals:
//   - agentState (running/waitingForInput/finished), agent-presence driven, for CLIs.
//   - terminalActivity (a foreground process running vs idle shell), for any command.
// Two wake triggers:
//   - DONE: the agent's turn ended — it returned to `waitingForInput` after running
//     (an interactive CLI stays alive at its prompt), or the CLI process exited
//     (`finished`); OR (no agent in play) the terminal's foreground process went
//     busy -> idle. Fired on the level, not an edge, so a transition we never
//     sampled (states coalesce between store ticks) can't be missed.
//   - STUCK: the task was backgrounded but never began — an agent parked in
//     `waitingForInput` without ever running (unsubmitted prompt / open dialog), or a
//     command terminal that never went busy at all — for longer than STUCK_WAIT_MS.
//     The driver is woken to inspect and nudge. We gate on "never started" so a
//     genuinely-working agent that briefly pauses for input is NOT woken (which would
//     disarm it and settle the iteration prematurely). The timer drives this check
//     because an idle terminal produces no store ticks.

/** A backgrounded task that never begins within this window is treated as stuck
 *  (unsubmitted prompt / open dialog / command that never launched). */
const STUCK_WAIT_MS = 90_000
/** Cadence of the stuck-check timer (an idle terminal emits no store updates). */
const SWEEP_INTERVAL_MS = 15_000

interface ArmedWake {
  driverPanelId: string
  wsId: string
  lastSeen: AgentState | null
  /** Whether we've ever observed the coding agent in `running` since arming. */
  everRunning: boolean
  /** Whether the terminal was ever busy — agent running OR a foreground process
   *  active. Distinguishes "command finished" from "command never started". */
  everBusy: boolean
  /** When the task first looked not-yet-started (else null), for the stuck timeout. */
  notStartedSince: number | null
}

const armed = new Map<string, ArmedWake>() // key: terminal panelId
let unsub: (() => void) | null = null
let sweepTimer: ReturnType<typeof setInterval> | null = null

function ensureWatcher(): void {
  if (!unsub) unsub = useStatusStore.subscribe(() => sweep())
  if (!sweepTimer) sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS)
}

function stopWatcher(): void {
  if (unsub) {
    unsub()
    unsub = null
  }
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

/** Evaluate every armed terminal for a DONE or STUCK wake. Runs on each store tick
 *  and on the slow timer. */
function sweep(): void {
  if (armed.size === 0) return
  for (const [terminalId, w] of [...armed]) {
    const ptyId = ptyFor(terminalId)
    const cur = ptyId ? agentStateFor(w.wsId, ptyId) : null
    const active = ptyId ? activityRunning(w.wsId, ptyId) : false
    // A coding agent is "in play" once we ever see an agent turn-state. While it is,
    // the agent signal is authoritative and the raw-activity path stays out of it.
    const agentEngaged = cur === 'running' || cur === 'waitingForInput' || cur === 'finished'
    const busy = cur === 'running' || active

    if (cur === 'running') w.everRunning = true
    if (busy) w.everBusy = true

    // DONE (agent): the agent's turn is over. An interactive CLI (claude/codex)
    // stays ALIVE at its prompt when a turn ends, so its state goes back to
    // `waitingForInput` — that, gated on "has run since arming", IS the turn-done
    // signal. `finished` only fires when the CLI process itself exits. Either way
    // we wake the driver, which inspects the screen and decides whether to nudge
    // (re-send, re-arming) or settle.
    if (cur === 'finished' && w.lastSeen !== 'finished') {
      onTerminalWake(terminalId, 'finished')
      continue
    }
    if (cur === 'waitingForInput' && w.everRunning) {
      onTerminalWake(terminalId, 'finished')
      continue
    }

    // DONE (command): no agent ever took over, the terminal was busy, now it's idle.
    if (!agentEngaged && w.everBusy && !busy) {
      onTerminalWake(terminalId, 'finished')
      continue
    }

    // STUCK: the task never started — an agent parked at its prompt without ever
    // running, or a command terminal that was never busy at all — for too long.
    const notStarted = (cur === 'waitingForInput' && !w.everRunning) || (!agentEngaged && !w.everBusy)
    if (notStarted) {
      if (w.notStartedSince == null) w.notStartedSince = Date.now()
      else if (Date.now() - w.notStartedSince >= STUCK_WAIT_MS) {
        onTerminalWake(terminalId, 'stuck')
        continue
      }
    } else {
      w.notStartedSince = null
    }
    w.lastSeen = cur
  }
}

/** Arm a one-shot wake for a backgrounded send_keys. The terminal's owning driver
 *  is taken from the registry (set by create_terminal). No-op for a terminal no
 *  driver owns. */
export function armBackgroundSend(wsId: string, terminalId: string): void {
  const owner = terminalOwner(terminalId)
  if (!owner) return
  ensureWatcher()
  const already = armed.has(terminalId)
  const ptyId = ptyFor(terminalId)
  const cur = ptyId ? agentStateFor(wsId, ptyId) : null
  const active = ptyId ? activityRunning(wsId, ptyId) : false
  armed.set(terminalId, {
    driverPanelId: owner,
    wsId,
    lastSeen: cur,
    everRunning: cur === 'running',
    everBusy: cur === 'running' || active,
    notStartedSince: null,
  })
  if (!already) incDriverOutstanding(owner)
}

/** Drop every armed wake owned by a driver. Called when the driver settles/tears
 *  down so the watcher doesn't linger on a dead session and the sweep timer can stop. */
export function disarmWakesForDriver(driverPanelId: string): void {
  for (const [terminalId, w] of [...armed]) {
    if (w.driverPanelId === driverPanelId) armed.delete(terminalId)
  }
  if (armed.size === 0) stopWatcher()
}

function onTerminalWake(terminalId: string, reason: 'finished' | 'stuck'): void {
  const w = armed.get(terminalId)
  if (!w) return
  armed.delete(terminalId)
  decDriverOutstanding(w.driverPanelId)
  if (armed.size === 0) stopWatcher()
  if (!hasContext(w.driverPanelId)) return // driver already torn down
  void deliverWake(w.driverPanelId, w.wsId, terminalId, reason)
}

/** Re-prompt the owning driver with the terminal's current screen/state. `reason`
 *  tailors the guidance: a finished turn vs an agent that never started. */
async function deliverWake(driverPanelId: string, wsId: string, terminalId: string, reason: 'finished' | 'stuck'): Promise<void> {
  const state = await readTerminalState(wsId, terminalId)
  const screen = state.output.length > 2000 ? state.output.slice(-2000) : state.output
  const tid = shortId(terminalId)
  const lead =
    reason === 'stuck'
      ? [
          `Terminal ${tid} hasn't started (agentState: ${state.agentState ?? 'unknown'}). Screen below:`,
          'submit a pending prompt with a bare Enter (keys:"" background:true), answer an open dialog, or re-send the task background:true.',
        ]
      : [
          `Terminal ${tid} finished (agentState: ${state.agentState ?? 'unknown'}). Screen below.`,
          'Nudge it again (send_keys background:true) if incomplete; otherwise end your turn once every terminal is done.',
        ]
  await promptCateAgent(driverPanelId, [...lead, `\n\n${screen}`].join(' '))
}

// --- create_terminal (driver only) ------------------------------------------

/** Grid slot for a driver's next terminal: column = its iteration's position
 *  within that iteration's round, row = terminals already recorded on the
 *  iteration (work + verify, so a verifier's terminal stacks below the work
 *  ones). Iteration not found → fall back to this driver's own terminal count. */
function driverSlot(ctx: CateAgentContext): AgentTerminalSlot {
  const todo = ctx.todoId
    ? useTodosStore.getState().getTodos(ctx.rootPath).find((t) => t.id === ctx.todoId)
    : undefined
  const iters = todo?.iterations ?? []
  const it = iters.find((i) => i.id === ctx.iterationId)
  const column = it ? iters.filter((i) => i.round === it.round).findIndex((i) => i.id === it.id) : 0
  const row = it ? it.agents.length : terminalsOwnedBy(ctx.panelId).length
  return { runKey: ctx.todoId ?? ctx.panelId, column, row }
}

/** Open a BARE shell terminal for a driver in its iteration's worktree, record the
 *  ownership (so the terminal's completion wakes this driver), and return its id.
 *  No launch command — the driver starts the CLI with its first send_keys. */
export async function openDriverTerminal(ctx: CateAgentContext): Promise<string> {
  const cwd = ctx.cwd ?? ctx.rootPath
  const glow = ctx.glow ?? 'rgb(var(--agent-rgb))'
  const terminalId = await openTerminal(ctx.workspaceId, cwd, glow, driverSlot(ctx), ctx.worktreeId)
  setTerminalOwner(terminalId, ctx.panelId)
  return terminalId
}

// --- run a driver to completion ---------------------------------------------

export interface RunDriverOpts {
  wsId: string
  rootPath: string
  /** Worktree cwd the driver's terminals open in. */
  cwd: string
  /** Glow color for the driver's controlled terminals. */
  glow: string
  /** Worktree the driver's terminals belong to (for the panel's worktree tag). */
  worktreeId?: string
  todoId: string
  iterationId: string
  /** Work driver (drive the iteration) vs verifier (grade it). */
  driverKind: 'work' | 'verify'
  /** The overview the work driver decomposes, or the verify prompt. */
  overview: string
}

/** The driver's seed: the task + cwd + the configured default CLI to launch.
 *  No CLI configured ⇒ the driver picks an installed one itself. */
function seedPrompt(opts: RunDriverOpts): string {
  const cli = loadCateAgentOrchestratorAgentCommand()
  const cliLine = cli
    ? `Default CLI: \`${cli}\` (use it unless you have reason to pick another).`
    : 'Pick an installed coding-agent CLI yourself (e.g. `claude`, `codex`).'
  return [
    `Iteration ${shortId(opts.iterationId)}, worktree: ${opts.cwd}. ${cliLine}`,
    opts.driverKind === 'verify'
      ? 'Exactly one agent must write the final .cate/verdict.json; if you split checks across terminals, have the others report back so one agent folds them in.'
      : '',
    opts.driverKind === 'verify' ? `\n\nVERIFY TASK: ${opts.overview}` : `\n\nOVERVIEW: ${opts.overview}`,
  ].filter(Boolean).join(' ')
}

/** Spawn a driver session for an iteration, seed it, and resolve once it SETTLES (a
 *  run ends with no outstanding background send_keys) or the session is disposed.
 *  Both work and verifier terminals stay open for the user (closed with the
 *  iteration, not on driver settle). Returns false if the driver session could not start. */
export async function runDriverToCompletion(opts: RunDriverOpts): Promise<boolean> {
  const key = opts.driverKind === 'verify' ? `${opts.iterationId}-verify` : opts.iterationId
  const panelId = driverPanelId(key)
  const ctx: CateAgentContext = {
    panelId,
    workspaceId: opts.wsId,
    rootPath: opts.rootPath,
    role: 'driver',
    todoId: opts.todoId,
    iterationId: opts.iterationId,
    driverKind: opts.driverKind,
    cwd: opts.cwd,
    glow: opts.glow,
    worktreeId: opts.worktreeId,
  }
  setContext(panelId, ctx)
  const ok = await createCateAgentSession({ panelId, rootPath: opts.rootPath, workspaceId: opts.wsId, role: 'driver', cwd: opts.cwd })
  if (!ok) {
    deleteContext(panelId)
    log.warn('[codingAgentLauncher] driver session failed to start for %s', panelId)
    return false
  }
  void promptCateAgent(panelId, seedPrompt(opts))

  // Settle loop: wait for the current run to end (the bridge signals every
  // agent_end), then settle iff no backgrounded send_keys is outstanding. The wait
  // BETWEEN runs is where the long parks live (a terminal still working); a wake
  // re-prompts the driver, starting the next run we catch here.
  const deadline = Date.now() + DRIVER_SETTLE_TIMEOUT_MS
  do {
    await awaitRunEnd(panelId, Math.max(1000, deadline - Date.now()))
  } while (hasContext(panelId) && driverOutstanding(panelId) > 0 && Date.now() < deadline)

  // Verifier terminals are kept open (same as the work phase) — the iteration's
  // chips keep representing them, and they're closed with the iteration by
  // select_winner / round-discard / job teardown, not on driver settle.
  disarmWakesForDriver(panelId)
  for (const t of terminalsOwnedBy(panelId)) clearTerminalOwner(t)
  clearDriverOutstanding(panelId)
  await disposeCateAgent(panelId)
  deleteContext(panelId)
  return true
}
