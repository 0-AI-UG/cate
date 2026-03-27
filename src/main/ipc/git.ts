// =============================================================================
// Git IPC handlers — repository detection and file listing
// =============================================================================

import { simpleGit } from 'simple-git'
import { ipcMain } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { GIT_IS_REPO, GIT_LS_FILES } from '../../shared/ipc-channels'

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
}
