// =============================================================================
// Shell / Process Monitor IPC handlers
// Walks the process tree to detect agent CLIs (Claude, Codex, etc.), dev-server
// ports, and working directory. The actual ps/lsof scans run inside each
// terminal's runtime ProcessHost (local OR remote daemon) — this module owns
// only the polling cadence, the owner-window routing, and the cross-scan
// carry-across that keeps tab names from flickering. For a LOCAL terminal the
// behaviour is byte-identical to before (the local ProcessHost runs the same
// ps/lsof); for a REMOTE terminal the scans run on the daemon host.
// =============================================================================

import { app, ipcMain } from 'electron'
import log from '../logger'
import {
  SHELL_ACTIVITY_UPDATE,
  SHELL_PORTS_UPDATE,
  SHELL_CWD_UPDATE,
  SHELL_AGENT_SCREEN_STATE,
  SHELL_AGENT_SESSION_UPDATE,
} from '../../shared/ipc-channels'
import { getRuntimeForTerminal, getTerminalIds, getTerminalOwner, onTerminalSessionsChanged } from './terminal'
import { sendToWindow, broadcastToAll, isAnyWindowFocused } from '../windowRegistry'
import type { Runtime, PtyActivity } from '../runtime/types'
import type { TerminalActivity, TerminalAgentSession } from '../../shared/types'

interface PreviousState {
  /** Last agent name seen — carried across transient scan misses so the tab
   *  name doesn't flicker when a single scan cycle fails to spot the agent. */
  previousAgentName: string | null
  /** Whether the last scan saw an agent — the falling edge (agent exited while
   *  the terminal lives on) clears the persisted resume stamp. */
  previousAgentPresent?: boolean
  /** When this terminal's agent session was last probed, for the throttle. */
  agentSessionProbedAt?: number
  /** Dedup key of the last SHELL_AGENT_SESSION_UPDATE sent, so an unchanged
   *  probe result doesn't re-emit (and re-touch renderer panel state). */
  agentSessionKey?: string | null
}

// Track previous state for transition detection
const previousStates: Map<string, PreviousState> = new Map()

// Last activity seen per terminal — used by the quit-confirmation flow to warn
// when a foreground process (dev server, editor, agent, …) is still running.
const lastActivity: Map<string, TerminalActivity> = new Map()

/**
 * Terminals that currently have a running foreground process, per the most
 * recent activity scan. Drives the "still running" confirmation shown before
 * the app quits. An idle shell reports `{ type: 'idle' }`, so it's excluded.
 */
export function getRunningTerminals(): Array<{ processName: string | null }> {
  const out: Array<{ processName: string | null }> = []
  for (const terminalId of getTerminalIds()) {
    const activity = lastActivity.get(terminalId)
    if (activity?.type === 'running') out.push({ processName: activity.processName })
  }
  return out
}

// Fast poll: process-tree scan for agent detection — drives the activity
// indicators and the agent "needs input" / "finished" notifications. It stays
// at 1s while a window is focused so the UI feels live, but backs off to 5s
// when the whole app is unfocused: the activity indicators aren't visible then,
// and agent "needs input" detection is driven by PTY title/spinner events in
// the renderer (event-based, not this scan), so a few extra seconds of presence
// latency costs nothing while the scan rate — the real background-CPU/battery
// drain — drops ~5×. (Each cycle forks one `ps` snapshot per runtime.)
const ACTIVITY_POLL_FOCUSED_MS = 1000
const ACTIVITY_POLL_UNFOCUSED_MS = 5000
let pollInterval: ReturnType<typeof setInterval> | null = null
let pollBusy = false

// Slow poll: the heavier lsof scans (listening ports + cwd). Ports/cwd rarely
// change second-to-second, so this rides a 5s timer while focused and backs off
// to 15s while unfocused (lsof is the priciest spawn we make).
const SLOW_POLL_FOCUSED_MS = 5000
const SLOW_POLL_UNFOCUSED_MS = 15000
let slowPollInterval: ReturnType<typeof setInterval> | null = null
let slowPollBusy = false

// While an agent CLI is present in a terminal, its stored session is re-probed
// on this cadence (newest-session lookup in the CLI's session store, on the
// terminal's runtime host) so the persisted resume stamp tracks session
// rotation (e.g. claude's /clear). Kept off the 1s loop — the probe stats
// session files / opens a sqlite db, and a ≤20s-stale stamp at quit is fine.
const AGENT_SESSION_PROBE_MS = 20_000

// Cadence the timers are currently running at, so applyPollCadence() can skip a
// needless clear/re-arm when focus flips but the resulting cadence is unchanged.
let activeActivityMs = 0
let activeSlowMs = 0

// True iff at least one app window is currently focused. The cwd scan (purely
// cosmetic — only consumed on demand by "Copy Working Directory") is skipped
// entirely while the app is unfocused.
let anyWindowFocused = true
let focusHooksInstalled = false

function refreshFocusState(): boolean {
  anyWindowFocused = isAnyWindowFocused()
  return anyWindowFocused
}

function installFocusHooks(): void {
  if (focusHooksInstalled) return
  focusHooksInstalled = true
  refreshFocusState()
  app.on('browser-window-focus', () => {
    const wasFocused = anyWindowFocused
    anyWindowFocused = true
    if (!wasFocused) {
      // Returning to the app — restore the fast cadence and take an immediate
      // scan so the activity indicators refresh without waiting out the timer.
      applyPollCadence()
      void runActivityScan()
    }
  })
  // browser-window-blur fires before focus transfers between this app's own
  // windows, so re-derive truth from the window list rather than trusting the
  // single event.
  app.on('browser-window-blur', () => {
    const stillFocused = refreshFocusState()
    if (!stillFocused) applyPollCadence()
  })
}

/**
 * Group the currently-registered terminal ids by the runtime that hosts them.
 * Terminals whose runtime can no longer be resolved are dropped from the scan
 * (they'll be cleaned up by the terminal exit / unregister path).
 */
function groupByRuntime(): Map<Runtime, string[]> {
  const groups = new Map<Runtime, string[]>()
  for (const terminalId of getTerminalIds()) {
    const runtime = getRuntimeForTerminal(terminalId)
    if (!runtime) continue
    const ids = groups.get(runtime)
    if (ids) ids.push(terminalId)
    else groups.set(runtime, [terminalId])
  }
  return groups
}

/**
 * Fast scan (1s focused / 5s unfocused): per-runtime process-tree scan for
 * agent activity. Emits SHELL_ACTIVITY_UPDATE to each terminal's owning window.
 */
async function runActivityScan(): Promise<void> {
  if (pollBusy) return
  pollBusy = true
  try {
    const groups = groupByRuntime()
    if (groups.size === 0) return

    await Promise.all(
      Array.from(groups.entries()).map(async ([runtime, ids]) => {
        // The daemon's scanActivity skips SIGSTOP-suspended ptys internally (their
        // process tree is frozen and can't change until resumed), so no client-side
        // filter is needed here — scan all ids the runtime hosts.
        const toScan = ids
        if (toScan.length === 0) return

        let results: Record<string, PtyActivity> = {}
        try {
          results = await runtime.process.scanActivity(toScan)
        } catch (err) {
          log.debug('[shell] scanActivity failed: %s', err instanceof Error ? err.message : String(err))
          return
        }

        for (const terminalId of toScan) {
          const ownerWindowId = getTerminalOwner(terminalId)
          if (ownerWindowId == null) continue
          const scanned = results[terminalId]
          const prev = previousStates.get(terminalId) || { previousAgentName: null }
          const activity: TerminalActivity = scanned?.activity ?? { type: 'idle' }
          // Carry the last-seen agent name across a transient miss (no flicker).
          const agentName = scanned?.agentName ?? prev.previousAgentName
          const agentPresent = scanned?.agentPresent ?? false

          const next: PreviousState = { ...prev, previousAgentName: agentName, previousAgentPresent: agentPresent }
          previousStates.set(terminalId, next)
          lastActivity.set(terminalId, activity)
          sendToWindow(ownerWindowId, SHELL_ACTIVITY_UPDATE, terminalId, activity, agentName, agentPresent)

          // Agent-session capture for terminal restore. While an agent is
          // present, re-probe its stored session on the throttled cadence
          // (immediately on the rising edge — probedAt resets on the falling
          // edge, so an agent relaunched within the window is picked up right
          // away). On the falling edge, clear the stamp: the agent exited
          // while the terminal lives on, so there is nothing to resume. An
          // app quit kills the poll loop itself, leaving the last stamp
          // persisted — exactly "what was running at save time".
          if (agentPresent) {
            const now = Date.now()
            if (now - (next.agentSessionProbedAt ?? 0) >= AGENT_SESSION_PROBE_MS) {
              next.agentSessionProbedAt = now
              void probeAndEmitAgentSession(runtime, terminalId)
            }
          } else if (prev.previousAgentPresent) {
            next.agentSessionProbedAt = 0
            emitAgentSession(terminalId, null)
          }
        }
      }),
    )
  } finally {
    pollBusy = false
  }
}

/** Send an agent-session stamp (or a clear) to the terminal's owner window,
 *  deduped against the last one sent for that terminal. */
function emitAgentSession(terminalId: string, session: TerminalAgentSession | null): void {
  const ownerWindowId = getTerminalOwner(terminalId)
  const state = previousStates.get(terminalId)
  if (ownerWindowId == null || !state) return
  const key = session ? `${session.agentId} ${session.sessionId} ${session.cwd}` : null
  if (state.agentSessionKey === key) return
  state.agentSessionKey = key
  sendToWindow(ownerWindowId, SHELL_AGENT_SESSION_UPDATE, terminalId, session)
}

/**
 * Quit-time stamp flush: re-probe EVERY terminal that currently has an agent,
 * emitting fresh SHELL_AGENT_SESSION_UPDATE stamps to the owner windows, so
 * the session save that follows persists the agent's CURRENT session rather
 * than one up to AGENT_SESSION_PROBE_MS stale (e.g. a /clear moments before
 * quit). Called from the before-quit sequence BEFORE the dock-window flush and
 * the main renderer's SESSION_FLUSH_SAVE — IPC ordering per window then
 * guarantees the renderer sees the stamps before it serializes panel state.
 * Bounded: a hung probe (dead remote) must never stall quit.
 */
export async function flushAgentSessionStamps(timeoutMs: number): Promise<void> {
  const probes: Promise<void>[] = []
  for (const terminalId of getTerminalIds()) {
    if (!previousStates.get(terminalId)?.previousAgentPresent) continue
    const runtime = getRuntimeForTerminal(terminalId)
    if (!runtime) continue
    probes.push(probeAndEmitAgentSession(runtime, terminalId))
  }
  if (probes.length === 0) return
  await Promise.race([
    Promise.allSettled(probes),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

async function probeAndEmitAgentSession(runtime: Runtime, terminalId: string): Promise<void> {
  let session: TerminalAgentSession | null = null
  try {
    session = await runtime.process.probeAgentSession(terminalId)
  } catch (err) {
    log.debug('[shell] probeAgentSession failed: %s', err instanceof Error ? err.message : String(err))
    return // transient failure — keep the last stamp rather than clearing it
  }
  // The agent may have exited while this probe was in flight — the falling
  // edge already cleared the stamp, and a late result must not resurrect it
  // (nothing is running to resume).
  if (!previousStates.get(terminalId)?.previousAgentPresent) return
  // A present agent with no stored session yet (just launched, nothing
  // prompted) probes to null — emit it so a stale stamp from an earlier
  // agent in this terminal doesn't outlive that agent's own sessions.
  emitAgentSession(terminalId, session)
}

/**
 * Slow scan (5s focused / 15s unfocused): the heavier lsof work. Listening ports
 * and cwd change rarely, so they don't belong on the 1s loop. The cwd scan is
 * skipped entirely while the app is unfocused (it only backs an on-demand
 * "Copy Working Directory" action).
 */
async function runSlowScan(): Promise<void> {
  if (slowPollBusy) return
  slowPollBusy = true
  try {
    const groups = groupByRuntime()
    if (groups.size === 0) return

    await Promise.all(
      Array.from(groups.entries()).map(async ([runtime, ids]) => {
        // --- CWD updates — focus-gated ---
        if (anyWindowFocused) {
          await Promise.all(
            ids.map(async (terminalId) => {
              try {
                const cwd = await runtime.process.getCwd(terminalId)
                const ownerWindowId = getTerminalOwner(terminalId)
                if (cwd && ownerWindowId != null) sendToWindow(ownerWindowId, SHELL_CWD_UPDATE, terminalId, cwd)
              } catch { /* ignore */ }
            }),
          )
        }

        // --- Port scan (scoped to each pty's process subtree on its host).
        //     Not focus-gated: still surfaces dev-server ports that come up while
        //     the app is backgrounded. ---
        let portMap: Record<string, number[]> = {}
        try {
          portMap = await runtime.process.scanPorts(ids)
        } catch (err) {
          log.debug('[shell] scanPorts failed: %s', err instanceof Error ? err.message : String(err))
        }
        for (const terminalId of ids) {
          const ownerWindowId = getTerminalOwner(terminalId)
          if (ownerWindowId == null) continue
          const ports = (portMap[terminalId] ?? []).slice().sort((a, b) => a - b)
          sendToWindow(ownerWindowId, SHELL_PORTS_UPDATE, terminalId, ports)
        }
      }),
    )
  } finally {
    slowPollBusy = false
  }
}

/**
 * (Re)arm both poll timers at the cadence matching the current focus state.
 * Called on first terminal registration and whenever app focus flips. No-op
 * when no terminals are registered, and a no-op when the cadence is already
 * correct (so a focus flip between this app's own windows doesn't churn timers).
 */
function applyPollCadence(): void {
  if (getTerminalIds().length === 0) return
  const activityMs = anyWindowFocused ? ACTIVITY_POLL_FOCUSED_MS : ACTIVITY_POLL_UNFOCUSED_MS
  const slowMs = anyWindowFocused ? SLOW_POLL_FOCUSED_MS : SLOW_POLL_UNFOCUSED_MS
  if (pollInterval && slowPollInterval && activeActivityMs === activityMs && activeSlowMs === slowMs) {
    return
  }
  if (pollInterval) clearInterval(pollInterval)
  if (slowPollInterval) clearInterval(slowPollInterval)
  activeActivityMs = activityMs
  activeSlowMs = slowMs
  pollInterval = setInterval(() => { void runActivityScan() }, activityMs)
  slowPollInterval = setInterval(() => { void runSlowScan() }, slowMs)
}

function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
  if (slowPollInterval) {
    clearInterval(slowPollInterval)
    slowPollInterval = null
  }
  activeActivityMs = 0
  activeSlowMs = 0
}

export function registerHandlers(): void {
  installFocusHooks()
  onTerminalSessionsChanged(() => {
    const activeIds = new Set(getTerminalIds())
    for (const terminalId of previousStates.keys()) {
      if (!activeIds.has(terminalId)) {
        previousStates.delete(terminalId)
        lastActivity.delete(terminalId)
      }
    }
    for (const terminalId of activeIds) {
      if (!previousStates.has(terminalId)) previousStates.set(terminalId, { previousAgentName: null })
    }
    if (activeIds.size === 0) stopPolling()
    else applyPollCadence()
  })

  // Renderer reports screen-derived agent state; rebroadcast so every
  // window's sidebar gets it (the sidebar in the main window won't otherwise
  // see state for terminals that live in a detached panel window).
  ipcMain.on(SHELL_AGENT_SCREEN_STATE, (_event, terminalId: string, state: string) => {
    broadcastToAll(SHELL_AGENT_SCREEN_STATE, terminalId, state)
  })

}
