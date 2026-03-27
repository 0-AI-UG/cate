// =============================================================================
// Git IPC handlers — repository detection and file listing
// =============================================================================

import { simpleGit } from 'simple-git'
import { ipcMain } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import {
  GIT_IS_REPO,
  GIT_LS_FILES,
  GIT_STATUS,
  GIT_DIFF,
  GIT_STAGE,
  GIT_UNSTAGE,
  GIT_COMMIT,
} from '../../shared/ipc-channels'

/**
 * Check if a directory is inside a git repository by looking for a .git directory.
 */
async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(dirPath, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * List tracked and untracked (non-ignored) files via git ls-files.
 * Returns relative paths from the repository root.
 */
async function lsFiles(dirPath: string): Promise<string[]> {
  try {
    const git = simpleGit(dirPath)
    const result = await git.raw([
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
    ])
    return result
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
}

export function registerHandlers(): void {
  ipcMain.handle(GIT_IS_REPO, async (_event, dirPath: string) => {
    return isGitRepo(dirPath)
  })

  ipcMain.handle(GIT_LS_FILES, async (_event, dirPath: string) => {
    return lsFiles(dirPath)
  })

  ipcMain.handle(GIT_STATUS, async (_event, cwd: string) => {
    const git = simpleGit(cwd)
    const status = await git.status()
    return {
      files: status.files.map(f => ({
        path: f.path,
        index: f.index,
        working_dir: f.working_dir,
      })),
      current: status.current,
      tracking: status.tracking,
      ahead: status.ahead,
      behind: status.behind,
    }
  })

  ipcMain.handle(GIT_DIFF, async (_event, cwd: string, filePath?: string) => {
    const git = simpleGit(cwd)
    if (filePath) {
      return await git.diff([filePath])
    }
    return await git.diff()
  })

  ipcMain.handle(GIT_STAGE, async (_event, cwd: string, filePath: string) => {
    const git = simpleGit(cwd)
    await git.add(filePath)
  })

  ipcMain.handle(GIT_UNSTAGE, async (_event, cwd: string, filePath: string) => {
    const git = simpleGit(cwd)
    await git.reset([filePath])
  })

  ipcMain.handle(GIT_COMMIT, async (_event, cwd: string, message: string) => {
    const git = simpleGit(cwd)
    await git.commit(message)
  })
}
