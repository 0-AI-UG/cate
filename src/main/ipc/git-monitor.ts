// =============================================================================
// Git Monitor — polls git branch + dirty status per workspace
// =============================================================================

import { execFile } from 'child_process'
import { ipcMain } from 'electron'
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
}

const activeMonitors: Map<string, MonitorEntry> = new Map()
const lastState: Map<string, { branch: string; isDirty: boolean }> = new Map()

function pollGitStatus(
  ownerWindowId: number,
  workspaceId: string,
  rootPath: string,
): void {
  execFile('git', ['-C', rootPath, 'branch', '--show-current'], {
    timeout: 3000,
  }, (err, branchOut) => {
    if (err) return

    const branch = branchOut.trim()
    if (!branch) return

    execFile('git', ['-C', rootPath, 'status', '--porcelain', '-uno'], {
      timeout: 3000,
    }, (err2, statusOut) => {
      if (err2) return

      const isDirty = statusOut.trim().length > 0

      const prev = lastState.get(workspaceId)
      if (prev && prev.branch === branch && prev.isDirty === isDirty) return

      lastState.set(workspaceId, { branch, isDirty })
      sendToWindow(ownerWindowId, GIT_BRANCH_UPDATE, workspaceId, branch, isDirty)
    })
  })
}

/**
 * Stop all monitors owned by a specific window (called on window close).
 */
export function stopMonitorsForWindow(windowId: number): void {
  for (const [workspaceId, entry] of activeMonitors) {
    if (entry.ownerWindowId === windowId) {
      clearInterval(entry.interval)
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
    }

    const win = windowFromEvent(event)
    const ownerWindowId = win?.id ?? -1

    pollGitStatus(ownerWindowId, workspaceId, validRoot)
    const interval = setInterval(() => {
      pollGitStatus(ownerWindowId, workspaceId, validRoot)
    }, POLL_INTERVAL_MS)

    activeMonitors.set(workspaceId, { interval, ownerWindowId })
  })

  ipcMain.on(GIT_MONITOR_STOP, (_event, workspaceId: string) => {
    const entry = activeMonitors.get(workspaceId)
    if (entry) {
      clearInterval(entry.interval)
      activeMonitors.delete(workspaceId)
    }
    lastState.delete(workspaceId)
  })
}
