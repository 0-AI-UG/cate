// =============================================================================
// Git Monitor — polls git branch + dirty status per workspace
// =============================================================================

import { execFile } from 'child_process'
import { ipcMain } from 'electron'
import log from '../logger'
import { validateCwd } from './pathValidation'
import {
  GIT_BRANCH_UPDATE,
  GIT_MONITOR_START,
  GIT_MONITOR_STOP,
} from '../../shared/ipc-channels'
import { sendToWindow, windowFromEvent } from '../windowRegistry'

const POLL_INTERVAL_MS = 5000

interface MonitorEntry {
  interval: ReturnType<typeof setInterval>
  ownerWindowId: number
  /** AbortController for the currently in-flight execFile calls. */
  abortController: AbortController | null
}

const activeMonitors: Map<string, MonitorEntry> = new Map()
const lastState: Map<string, { branch: string; isDirty: boolean; branchesKey: string }> = new Map()

function runGit(rootPath: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
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

async function pollGitStatus(
  ownerWindowId: number,
  workspaceId: string,
  rootPath: string,
  entry: MonitorEntry,
): Promise<void> {
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
    if (!branch) return

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
    ) return

    lastState.set(workspaceId, { branch, isDirty, branchesKey })
    sendToWindow(ownerWindowId, GIT_BRANCH_UPDATE, workspaceId, branch, isDirty)
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ABORT_ERR') return
    log.debug(
      'git monitor poll failed for %s: %s',
      rootPath,
      err instanceof Error ? err.message : String(err),
    )
  }
}

/**
 * Stop all monitors owned by a specific window (called on window close).
 */
export function stopMonitorsForWindow(windowId: number): void {
  for (const [workspaceId, entry] of activeMonitors) {
    if (entry.ownerWindowId === windowId) {
      clearInterval(entry.interval)
      entry.abortController?.abort()
      activeMonitors.delete(workspaceId)
      lastState.delete(workspaceId)
    }
  }
}

export function registerHandlers(): void {
  ipcMain.on(GIT_MONITOR_START, (event, workspaceId: string, rootPath: string) => {
    const validRoot = validateCwd(rootPath)
    const existing = activeMonitors.get(workspaceId)
    if (existing) {
      clearInterval(existing.interval)
      existing.abortController?.abort()
    }

    const win = windowFromEvent(event)
    const ownerWindowId = win?.id ?? -1

    // Create the entry first so pollGitStatus can reference it for AbortController
    const entry: MonitorEntry = {
      interval: null as unknown as ReturnType<typeof setInterval>,
      ownerWindowId,
      abortController: null,
    }

    pollGitStatus(ownerWindowId, workspaceId, validRoot, entry)
    entry.interval = setInterval(() => {
      pollGitStatus(ownerWindowId, workspaceId, validRoot, entry)
    }, POLL_INTERVAL_MS)

    activeMonitors.set(workspaceId, entry)
  })

  ipcMain.on(GIT_MONITOR_STOP, (_event, workspaceId: string) => {
    const entry = activeMonitors.get(workspaceId)
    if (entry) {
      clearInterval(entry.interval)
      entry.abortController?.abort()
      activeMonitors.delete(workspaceId)
    }
    lastState.delete(workspaceId)
  })
}
