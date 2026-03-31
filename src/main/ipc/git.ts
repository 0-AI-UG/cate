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
  GIT_WORKTREE_LIST,
  GIT_PUSH,
  GIT_PULL,
  GIT_FETCH,
  GIT_LOG,
  GIT_BRANCH_LIST,
  GIT_BRANCH_CREATE,
  GIT_BRANCH_DELETE,
  GIT_CHECKOUT,
  GIT_DIFF_STAGED,
  GIT_STASH,
  GIT_STASH_POP,
  GIT_DISCARD_FILE,
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

  ipcMain.handle(GIT_PUSH, async (_event, cwd: string, remote?: string, branch?: string) => {
    const git = simpleGit(cwd)
    await git.push(remote || 'origin', branch)
  })

  ipcMain.handle(GIT_PULL, async (_event, cwd: string, remote?: string, branch?: string) => {
    const git = simpleGit(cwd)
    const result = await git.pull(remote || 'origin', branch)
    return {
      summary: {
        changes: result.summary.changes,
        insertions: result.summary.insertions,
        deletions: result.summary.deletions,
      },
    }
  })

  ipcMain.handle(GIT_FETCH, async (_event, cwd: string, remote?: string) => {
    const git = simpleGit(cwd)
    await git.fetch(remote || 'origin')
  })

  ipcMain.handle(GIT_LOG, async (_event, cwd: string, maxCount?: number) => {
    const git = simpleGit(cwd)
    const log = await git.log({ maxCount: maxCount || 50 })
    return log.all.map(entry => ({
      hash: entry.hash,
      message: entry.message,
      author_name: entry.author_name,
      author_email: entry.author_email,
      date: entry.date,
    }))
  })

  ipcMain.handle(GIT_BRANCH_LIST, async (_event, cwd: string) => {
    const git = simpleGit(cwd)
    const result = await git.branch(['-a', '--sort=-committerdate'])
    return {
      current: result.current,
      branches: Object.entries(result.branches).map(([name, info]) => ({
        name,
        current: info.current,
        commit: info.commit,
        label: info.label,
        isRemote: name.startsWith('remotes/'),
      })),
    }
  })

  ipcMain.handle(GIT_BRANCH_CREATE, async (_event, cwd: string, branchName: string, startPoint?: string) => {
    const git = simpleGit(cwd)
    await git.checkoutLocalBranch(branchName)
  })

  ipcMain.handle(GIT_BRANCH_DELETE, async (_event, cwd: string, branchName: string, force?: boolean) => {
    const git = simpleGit(cwd)
    if (force) {
      await git.branch(['-D', branchName])
    } else {
      await git.branch(['-d', branchName])
    }
  })

  ipcMain.handle(GIT_CHECKOUT, async (_event, cwd: string, branchName: string) => {
    const git = simpleGit(cwd)
    await git.checkout(branchName)
  })

  ipcMain.handle(GIT_DIFF_STAGED, async (_event, cwd: string, filePath?: string) => {
    const git = simpleGit(cwd)
    if (filePath) {
      return await git.diff(['--cached', filePath])
    }
    return await git.diff(['--cached'])
  })

  ipcMain.handle(GIT_STASH, async (_event, cwd: string, message?: string) => {
    const git = simpleGit(cwd)
    if (message) {
      await git.stash(['push', '-m', message])
    } else {
      await git.stash()
    }
  })

  ipcMain.handle(GIT_STASH_POP, async (_event, cwd: string) => {
    const git = simpleGit(cwd)
    await git.stash(['pop'])
  })

  ipcMain.handle(GIT_DISCARD_FILE, async (_event, cwd: string, filePath: string) => {
    const git = simpleGit(cwd)
    await git.checkout(['--', filePath])
  })

  ipcMain.handle(GIT_WORKTREE_LIST, async (_event, cwd: string) => {
    try {
      const git = simpleGit(cwd)
      const raw = await git.raw(['worktree', 'list', '--porcelain'])
      const worktrees: Array<{
        path: string
        branch: string
        isBare: boolean
        isCurrent: boolean
      }> = []

      // Parse porcelain output — blocks separated by blank lines
      const blocks = raw.trim().split('\n\n')
      for (const block of blocks) {
        const lines = block.split('\n')
        let wtPath = ''
        let branch = ''
        let isBare = false
        for (const line of lines) {
          if (line.startsWith('worktree ')) {
            wtPath = line.slice('worktree '.length)
          } else if (line.startsWith('branch ')) {
            // branch refs/heads/main -> main
            branch = line.slice('branch '.length).replace('refs/heads/', '')
          } else if (line === 'bare') {
            isBare = true
          } else if (line.startsWith('HEAD ') && !branch) {
            // detached HEAD — show abbreviated SHA
            branch = line.slice('HEAD '.length).substring(0, 8)
          }
        }
        if (wtPath) {
          worktrees.push({
            path: wtPath,
            branch: branch || '(unknown)',
            isBare,
            isCurrent: path.resolve(wtPath) === path.resolve(cwd),
          })
        }
      }
      return worktrees
    } catch {
      return []
    }
  })
}
