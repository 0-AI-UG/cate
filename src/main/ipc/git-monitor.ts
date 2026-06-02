// =============================================================================
// Git Monitor — polls git branch + dirty status per workspace
// =============================================================================

import { app, BrowserWindow, ipcMain } from 'electron'
import log from '../logger'
import {
  GIT_BRANCH_UPDATE,
  GIT_MONITOR_START,
  GIT_MONITOR_STOP,
} from '../../shared/ipc-channels'
import { sendToWindow, windowFromEvent } from '../windowRegistry'
import { parseLocator } from '../companion/locator'
import { companions } from '../companion/companionManager'
import type { Companion } from '../companion/types'

// Adaptive polling: start fast right after a detected change, back off
// exponentially while nothing changes, cap at 30s. Reset to MIN on any
// observed change or when focus returns from a blurred state.
const POLL_INTERVAL_MIN_MS = 2000
const POLL_INTERVAL_MAX_MS = 30000

interface MonitorEntry {
  timer: ReturnType<typeof setTimeout> | null
  ownerWindowId: number
  rootPath: string
  workspaceId: string
  /** Companion hosting this workspace (local or remote); polled for status. */
  companion: Companion
  /** Next delay to schedule after the current poll completes (ms). */
  nextDelayMs: number
  /** Incremented on every poll start; a poll whose epoch is stale (a newer
   *  poll was kicked, or the monitor was torn down) discards its result. This
   *  replaces the old execFile AbortController, which only abort()-ed local
   *  child processes that no longer exist on this path. */
  pollEpoch: number
  /** Unsubscribe fn from the shared chokidar pool, if wired. */
  unsubscribeFs: (() => void) | null
  /** Coalesce fs-watcher bursts into at most one immediate poll. */
  fsKickPending: boolean
}

const activeMonitors: Map<string, MonitorEntry> = new Map()
const lastState: Map<string, { branch: string; isDirty: boolean; branchesKey: string }> = new Map()

/** True iff at least one BrowserWindow is currently focused. */
let anyWindowFocused: boolean = false

function refreshFocusState(): boolean {
  const wins = BrowserWindow.getAllWindows()
  anyWindowFocused = wins.some((w) => !w.isDestroyed() && w.isFocused())
  return anyWindowFocused
}

function clearTimer(entry: MonitorEntry): void {
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
}

function scheduleNext(entry: MonitorEntry, delayMs: number): void {
  clearTimer(entry)
  if (!anyWindowFocused) {
    // Paused while no window has focus — focus handler will re-schedule.
    return
  }
  entry.timer = setTimeout(() => {
    void tick(entry)
  }, delayMs)
}

async function tick(entry: MonitorEntry): Promise<void> {
  entry.timer = null
  if (!anyWindowFocused) return
  const changed = await pollGitStatus(entry)
  if (changed) {
    entry.nextDelayMs = POLL_INTERVAL_MIN_MS
  } else {
    entry.nextDelayMs = Math.min(entry.nextDelayMs * 2, POLL_INTERVAL_MAX_MS)
  }
  scheduleNext(entry, entry.nextDelayMs)
}

/**
 * Run one git poll via the workspace's companion. For the local companion this
 * is byte-identical to the old raw-git poll (same `git branch/status/for-each-ref`
 * commands, run by the unified vcs capability); for a remote companion the
 * commands run on the daemon host, so the sidebar reflects the remote repo.
 * Returns true iff observable state changed (and a GIT_BRANCH_UPDATE was sent),
 * which drives the adaptive interval reset.
 */
async function pollGitStatus(entry: MonitorEntry): Promise<boolean> {
  const { ownerWindowId, workspaceId, rootPath, companion } = entry

  // A newer poll (or teardown) supersedes this one: bump the epoch, and discard
  // our own result if it changes again before we resolve.
  const epoch = ++entry.pollEpoch

  try {
    const { branch, dirty: isDirty, branches } = await companion.vcs.monitorStatus(rootPath)

    // Stale: a fresher poll started, or the monitor was torn down/restarted.
    if (entry.pollEpoch !== epoch || !activeMonitors.has(workspaceId)) return false

    if (!branch) return false

    // Sort so reordering (e.g. committerdate changes) doesn't spuriously
    // look like a list change; a newline-joined canonical string is
    // cheaper to diff than the array.
    const branchesKey = [...branches].sort().join('\n')

    const prev = lastState.get(workspaceId)
    if (
      prev
      && prev.branch === branch
      && prev.isDirty === isDirty
      && prev.branchesKey === branchesKey
    ) return false

    lastState.set(workspaceId, { branch, isDirty, branchesKey })
    sendToWindow(ownerWindowId, GIT_BRANCH_UPDATE, workspaceId, branch, isDirty)
    return true
  } catch (err) {
    log.debug(
      'git monitor poll failed for %s: %s',
      rootPath,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

/** Resume polling for every active monitor (called on focus return). */
function resumeAllMonitors(): void {
  for (const entry of activeMonitors.values()) {
    // Treat focus return like a detected change: poll immediately and
    // reset back-off so the user sees a fresh state right away.
    entry.nextDelayMs = POLL_INTERVAL_MIN_MS
    clearTimer(entry)
    void tick(entry)
  }
}

/** Pause every active monitor (called when all windows blur). */
function pauseAllMonitors(): void {
  for (const entry of activeMonitors.values()) {
    clearTimer(entry)
    // Supersede any in-flight poll so its late result is discarded.
    entry.pollEpoch++
  }
}

let appHooksInstalled = false
function installAppHooks(): void {
  if (appHooksInstalled) return
  appHooksInstalled = true
  refreshFocusState()
  app.on('browser-window-focus', () => {
    const wasFocused = anyWindowFocused
    anyWindowFocused = true
    if (!wasFocused) resumeAllMonitors()
  })
  app.on('browser-window-blur', () => {
    // browser-window-blur fires *before* focus transfers to another window
    // in the same app, so re-derive truth from the window list rather than
    // trusting a single event.
    const stillFocused = refreshFocusState()
    if (!stillFocused) pauseAllMonitors()
  })
}

/**
 * Stop all monitors owned by a specific window (called on window close).
 */
export function stopMonitorsForWindow(windowId: number): void {
  for (const [workspaceId, entry] of activeMonitors) {
    if (entry.ownerWindowId === windowId) {
      clearTimer(entry)
      entry.pollEpoch++
      entry.unsubscribeFs?.()
      activeMonitors.delete(workspaceId)
      lastState.delete(workspaceId)
    }
  }
}

export function registerHandlers(): void {
  installAppHooks()

  ipcMain.on(GIT_MONITOR_START, (event, workspaceId: string, rootPath: string) => {
    // `ipcMain.on` handlers have no promise boundary, so any throw inside
    // escapes as an uncaught exception and crashes the main process with a
    // fatal Electron dialog. Path validation is legitimately expected to fail
    // here during session restore (renderer requests monitoring before the
    // workspace root has been registered as an allowed root), so treat a
    // validation failure as "don't start monitoring" instead of a hard error.
    // Resolve the target companion off the locator, then validate. For the
    // local companion this is identical to the previous validateCwd(rootPath).
    // The poll itself routes through companion.vcs.monitorStatus, so a remote
    // workspace's branch/dirty indicator reflects the remote repo.
    const { companionId, path: rootP } = parseLocator(rootPath)
    let companion: ReturnType<typeof companions.resolve>
    let validRoot: string
    try {
      companion = companions.resolve(companionId)
      validRoot = companion.validateCwd(rootP)
    } catch (err) {
      log.warn(
        '[git-monitor] skipping monitor for workspace %s: %s',
        workspaceId,
        err instanceof Error ? err.message : String(err),
      )
      return
    }
    const existing = activeMonitors.get(workspaceId)
    if (existing) {
      clearTimer(existing)
      existing.pollEpoch++
      existing.unsubscribeFs?.()
    }

    const win = windowFromEvent(event)
    const ownerWindowId = win?.id ?? -1

    const entry: MonitorEntry = {
      timer: null,
      ownerWindowId,
      rootPath: validRoot,
      workspaceId,
      companion,
      nextDelayMs: POLL_INTERVAL_MIN_MS,
      pollEpoch: 0,
      unsubscribeFs: null,
      fsKickPending: false,
    }

    // Wire fs-watcher events from the shared chokidar pool to trigger an
    // immediate poll. The periodic timer becomes a safety net for changes
    // chokidar may miss (e.g. atomic renames on some filesystems, or repo
    // mutations that happen before any watcher root covers this path).
    entry.unsubscribeFs = companion.file.watch(validRoot, () => {
      if (!anyWindowFocused) return
      if (entry.fsKickPending) return
      entry.fsKickPending = true
      // Coalesce the inbound burst on the next tick before kicking a poll.
      setImmediate(() => {
        entry.fsKickPending = false
        if (!activeMonitors.has(workspaceId)) return
        entry.nextDelayMs = POLL_INTERVAL_MIN_MS
        clearTimer(entry)
        void tick(entry)
      })
    })

    activeMonitors.set(workspaceId, entry)

    // Kick off the first poll immediately, then let tick() schedule.
    void tick(entry)
  })

  ipcMain.on(GIT_MONITOR_STOP, (_event, workspaceId: string) => {
    const entry = activeMonitors.get(workspaceId)
    if (entry) {
      clearTimer(entry)
      entry.pollEpoch++
      entry.unsubscribeFs?.()
      activeMonitors.delete(workspaceId)
    }
    lastState.delete(workspaceId)
  })
}
