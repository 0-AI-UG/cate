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

import { app, BrowserWindow, ipcMain } from 'electron'
import log from '../logger'
import {
  SHELL_REGISTER_TERMINAL,
  SHELL_UNREGISTER_TERMINAL,
  SHELL_ACTIVITY_UPDATE,
  SHELL_PORTS_UPDATE,
  SHELL_CWD_UPDATE,
  SHELL_AGENT_SCREEN_STATE,
} from '../../shared/ipc-channels'
import { getRuntimeForTerminal } from './terminal'
import { sendToWindow, windowFromEvent, broadcastToAll } from '../windowRegistry'
import type { Runtime, PtyActivity } from '../runtime/types'
import type { TerminalActivity } from '../../shared/types'

interface TerminalRegistration {
  ownerWindowId: number
}

interface PreviousState {
  /** Last agent name seen — carried across transient scan misses so the tab
   *  name doesn't flicker when a single scan cycle fails to spot the agent. */
  previousAgentName: string | null
}

// Registered terminals for process monitoring (keyed by pty id == terminal id).
const registeredTerminals: Map<string, TerminalRegistration> = new Map()

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
  for (const terminalId of registeredTerminals.keys()) {
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
  anyWindowFocused = BrowserWindow.getAllWindows().some(
    (w) => !w.isDestroyed() && w.isFocused(),
  )
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
  for (const terminalId of registeredTerminals.keys()) {
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
          const info = registeredTerminals.get(terminalId)
          if (!info) continue
          const scanned = results[terminalId]
          const prev = previousStates.get(terminalId) || { previousAgentName: null }
          const activity: TerminalActivity = scanned?.activity ?? { type: 'idle' }
          // Carry the last-seen agent name across a transient miss (no flicker).
          const agentName = scanned?.agentName ?? prev.previousAgentName
          const agentPresent = scanned?.agentPresent ?? false

          previousStates.set(terminalId, { previousAgentName: agentName })
          lastActivity.set(terminalId, activity)
          sendToWindow(info.ownerWindowId, SHELL_ACTIVITY_UPDATE, terminalId, activity, agentName, agentPresent)
        }
      }),
    )
  } finally {
    pollBusy = false
  }
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
                const info = registeredTerminals.get(terminalId)
                if (cwd && info) sendToWindow(info.ownerWindowId, SHELL_CWD_UPDATE, terminalId, cwd)
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
          const info = registeredTerminals.get(terminalId)
          if (!info) continue
          const ports = (portMap[terminalId] ?? []).slice().sort((a, b) => a - b)
          sendToWindow(info.ownerWindowId, SHELL_PORTS_UPDATE, terminalId, ports)
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
  if (registeredTerminals.size === 0) return
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

/**
 * Unregister all terminals owned by a specific window (called on window close).
 */
export function unregisterTerminalsForWindow(windowId: number): void {
  for (const [terminalId, info] of registeredTerminals) {
    if (info.ownerWindowId === windowId) {
      registeredTerminals.delete(terminalId)
      previousStates.delete(terminalId)
      lastActivity.delete(terminalId)
    }
  }
  if (registeredTerminals.size === 0) {
    stopPolling()
  }
}

export function registerHandlers(): void {
  installFocusHooks()

  ipcMain.handle(
    SHELL_REGISTER_TERMINAL,
    async (event, terminalId: string, _pid?: number) => {
      // The scans are now keyed by the pty id and run inside the terminal's
      // runtime ProcessHost (which owns the pid), so we no longer need a local
      // pid here — only that the terminal resolves to a runtime. (The legacy
      // `pid` arg is accepted but unused.)
      const runtime = getRuntimeForTerminal(terminalId)
      if (!runtime) {
        log.warn(`[shell] No runtime found for terminal ${terminalId}`)
        return
      }

      const win = windowFromEvent(event)
      const ownerWindowId = win?.id ?? -1

      registeredTerminals.set(terminalId, { ownerWindowId })
      previousStates.set(terminalId, { previousAgentName: null })

      // Start (or re-confirm) polling on first registration, at the cadence
      // matching the current focus state.
      applyPollCadence()
    },
  )

  // Renderer reports screen-derived agent state; rebroadcast so every
  // window's sidebar gets it (the sidebar in the main window won't otherwise
  // see state for terminals that live in a detached panel window).
  ipcMain.on(SHELL_AGENT_SCREEN_STATE, (_event, terminalId: string, state: string) => {
    broadcastToAll(SHELL_AGENT_SCREEN_STATE, terminalId, state)
  })

  ipcMain.handle(SHELL_UNREGISTER_TERMINAL, async (_event, terminalId: string) => {
    registeredTerminals.delete(terminalId)
    previousStates.delete(terminalId)
    lastActivity.delete(terminalId)
    if (registeredTerminals.size === 0) {
      stopPolling()
    }
  })
}
