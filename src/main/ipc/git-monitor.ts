// =============================================================================
// Git Monitor — polls git branch + dirty status per workspace
// =============================================================================

import { execFile } from 'child_process'
import { app, BrowserWindow, ipcMain } from 'electron'
import log from '../logger'
import { validateCwd } from './pathValidation'
import {
  GIT_BRANCH_UPDATE,
  GIT_MONITOR_START,
  GIT_MONITOR_STOP,
} from '../../shared/ipc-channels'
import { sendToWindow, windowFromEvent } from '../windowRegistry'
import { subscribeFsChanges } from './filesystem'
import { countSpawn } from '../perf/perfMonitor'

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
  /** Next delay to schedule after the current poll completes (ms). */
  nextDelayMs: number
  /** AbortController for the currently in-flight execFile calls. */
  abortController: AbortController | null
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

function runGit(rootPath: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    countSpawn('git')
    execFile(
      'git',
      ['-C', rootPath, ...args],
      { timeout: 3000, signal },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
            reject(err)
            return
          }
          // Surface stderr when available so the caller can log it.
          reject(new Error(stderr?.trim() || err.message))
          return
        }
        resolve(stdout)
      },
    )
  })
}

/**
 * Run one git poll. Returns true iff observable state changed (and a
 * GIT_BRANCH_UPDATE was sent), which drives the adaptive interval reset.
 */
async function pollGitStatus(entry: MonitorEntry): Promise<boolean> {
  const { ownerWindowId, workspaceId, rootPath } = entry

  // Abort any previous in-flight calls for this workspace
  entry.abortController?.abort()
  const ac = new AbortController()
  entry.abortController = ac

  try {
    // Current branch, dirty flag, and the full local branch list run in
    // parallel — deletion of a non-current branch doesn't change the
    // first two, so we need the third to detect it and re-notify the UI.
    const [branchOut, statusOut, branchesOut] = await Promise.all([
      runGit(rootPath, ['branch', '--show-current'], ac.signal),
      runGit(rootPath, ['status', '--porcelain', '-uno'], ac.signal),
      runGit(rootPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], ac.signal),
    ])

    if (entry.abortController === ac) entry.abortController = null

    const branch = branchOut.trim()
    if (!branch) return false

    const isDirty = statusOut.trim().length > 0
    // Sort so reordering (e.g. committerdate changes) doesn't spuriously
    // look like a list change; a newline-joined canonical string is
    // cheaper to diff than the array.
    const branchesKey = branchesOut
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort()
      .join('\n')

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
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ABORT_ERR') return false
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
    entry.abortController?.abort()
    entry.abortController = null
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
      entry.abortController?.abort()
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
    let validRoot: string
    try {
      validRoot = validateCwd(rootPath)
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
      existing.abortController?.abort()
      existing.unsubscribeFs?.()
    }

    const win = windowFromEvent(event)
    const ownerWindowId = win?.id ?? -1

    const entry: MonitorEntry = {
      timer: null,
      ownerWindowId,
      rootPath: validRoot,
      workspaceId,
      nextDelayMs: POLL_INTERVAL_MIN_MS,
      abortController: null,
      unsubscribeFs: null,
      fsKickPending: false,
    }

    // Wire fs-watcher events from the shared chokidar pool to trigger an
    // immediate poll. The periodic timer becomes a safety net for changes
    // chokidar may miss (e.g. atomic renames on some filesystems, or repo
    // mutations that happen before any watcher root covers this path).
    entry.unsubscribeFs = subscribeFsChanges(validRoot, () => {
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
      entry.abortController?.abort()
      entry.unsubscribeFs?.()
      activeMonitors.delete(workspaceId)
    }
    lastState.delete(workspaceId)
  })
}
