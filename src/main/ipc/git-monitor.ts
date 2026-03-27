// =============================================================================
// Git Monitor — polls git branch + dirty status per workspace
// =============================================================================

import { execFile } from 'child_process'
import { ipcMain, BrowserWindow } from 'electron'
import {
  GIT_BRANCH_UPDATE,
  GIT_MONITOR_START,
  GIT_MONITOR_STOP,
} from '../../shared/ipc-channels'

const POLL_INTERVAL_MS = 5000

const activeMonitors: Map<string, ReturnType<typeof setInterval>> = new Map()
const lastState: Map<string, { branch: string; isDirty: boolean }> = new Map()

function pollGitStatus(
  mainWindow: BrowserWindow,
  workspaceId: string,
  rootPath: string,
): void {
  execFile('git', ['-C', rootPath, 'branch', '--show-current'], {
    timeout: 3000,
  }, (err, branchOut) => {
    if (err || mainWindow.isDestroyed()) return

    const branch = branchOut.trim()
    if (!branch) return

    execFile('git', ['-C', rootPath, 'status', '--porcelain', '-uno'], {
      timeout: 3000,
    }, (err2, statusOut) => {
      if (err2 || mainWindow.isDestroyed()) return

      const isDirty = statusOut.trim().length > 0

      const prev = lastState.get(workspaceId)
      if (prev && prev.branch === branch && prev.isDirty === isDirty) return

      lastState.set(workspaceId, { branch, isDirty })
      mainWindow.webContents.send(GIT_BRANCH_UPDATE, workspaceId, branch, isDirty)
    })
  })
}

export function registerHandlers(mainWindow: BrowserWindow): void {
  ipcMain.on(GIT_MONITOR_START, (_event, workspaceId: string, rootPath: string) => {
    const existing = activeMonitors.get(workspaceId)
    if (existing) {
      clearInterval(existing)
    }

    pollGitStatus(mainWindow, workspaceId, rootPath)
    const interval = setInterval(() => {
      pollGitStatus(mainWindow, workspaceId, rootPath)
    }, POLL_INTERVAL_MS)

    activeMonitors.set(workspaceId, interval)
  })

  ipcMain.on(GIT_MONITOR_STOP, (_event, workspaceId: string) => {
    const interval = activeMonitors.get(workspaceId)
    if (interval) {
      clearInterval(interval)
      activeMonitors.delete(workspaceId)
    }
    lastState.delete(workspaceId)
  })
}
