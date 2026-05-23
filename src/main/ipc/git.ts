// =============================================================================
// Git IPC handlers — repository detection and file listing
// =============================================================================

import { simpleGit } from 'simple-git'
import { ipcMain } from 'electron'
import log from '../logger'
import fs from 'fs/promises'
import path from 'path'
import { validateCwd, addAllowedRoot, removeAllowedRoot } from './pathValidation'
import {
  GIT_IS_REPO,
  GIT_LS_FILES,
  GIT_STATUS,
  GIT_DIFF,
  GIT_STAGE,
  GIT_UNSTAGE,
  GIT_COMMIT,
  GIT_WORKTREE_LIST,
  GIT_WORKTREE_ADD,
  GIT_WORKTREE_REMOVE,
  GIT_WORKTREE_PRUNE,
  GIT_WORKTREE_STATUS,
  GIT_WORKTREE_MERGE_TO,
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
 * Validate that filePath stays inside cwd and return its relative form.
 * Throws if filePath resolves outside the workspace root.
 */
function validateFilePath(cwd: string, filePath: string): string {
  const resolvedCwd = path.resolve(cwd)
  const resolved = path.resolve(cwd, filePath)
  if (resolved !== resolvedCwd && !resolved.startsWith(resolvedCwd + path.sep)) {
    throw new Error('filePath escapes workspace')
  }
  return path.relative(cwd, resolved)
}

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

export async function createBranch(cwd: string, branchName: string, startPoint?: string): Promise<void> {
  const git = simpleGit(validateCwd(cwd))
  if (startPoint) {
    await git.checkoutBranch(branchName, startPoint)
  } else {
    await git.checkoutLocalBranch(branchName)
  }
}

export function registerHandlers(): void {
  ipcMain.handle(GIT_IS_REPO, async (_event, dirPath: string) => {
    return isGitRepo(validateCwd(dirPath))
  })

  ipcMain.handle(GIT_LS_FILES, async (_event, dirPath: string) => {
    return lsFiles(validateCwd(dirPath))
  })

  ipcMain.handle(GIT_STATUS, async (_event, cwd: string) => {
    try {
      const git = simpleGit(validateCwd(cwd))
      const status = await git.status()
      return {
        files: status.files.map((f) => ({
          path: f.path,
          index: f.index,
          working_dir: f.working_dir,
        })),
        current: status.current,
        tracking: status.tracking,
        ahead: status.ahead,
        behind: status.behind,
      }
    } catch (error) {
      log.error(`[${GIT_STATUS}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(GIT_DIFF, async (_event, cwd: string, filePath?: string) => {
    try {
      const validCwd = validateCwd(cwd)
      const git = simpleGit(validCwd)
      if (filePath) {
        return await git.diff([validateFilePath(validCwd, filePath)])
      }
      return await git.diff()
    } catch (error) {
      log.error(`[${GIT_DIFF}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(GIT_STAGE, async (_event, cwd: string, filePath: string) => {
    try {
      const validCwd = validateCwd(cwd)
      const git = simpleGit(validCwd)
      await git.add(validateFilePath(validCwd, filePath))
    } catch (error) {
      log.error(`[${GIT_STAGE}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(GIT_UNSTAGE, async (_event, cwd: string, filePath: string) => {
    try {
      const validCwd = validateCwd(cwd)
      const git = simpleGit(validCwd)
      await git.reset([validateFilePath(validCwd, filePath)])
    } catch (error) {
      log.error(`[${GIT_UNSTAGE}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(GIT_COMMIT, async (_event, cwd: string, message: string) => {
    try {
      const git = simpleGit(validateCwd(cwd))
      await git.commit(message)
    } catch (error) {
      log.error(`[${GIT_COMMIT}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(GIT_PUSH, async (_event, cwd: string, remote?: string, branch?: string) => {
    try {
      const git = simpleGit(validateCwd(cwd))
      await git.push(remote || 'origin', branch)
    } catch (error) {
      log.error(`[${GIT_PUSH}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(GIT_PULL, async (_event, cwd: string, remote?: string, branch?: string) => {
    try {
      const git = simpleGit(validateCwd(cwd))
      const result = await git.pull(remote || 'origin', branch)
      return {
        summary: {
          changes: result.summary.changes,
          insertions: result.summary.insertions,
          deletions: result.summary.deletions,
        },
      }
    } catch (error) {
      log.error(`[${GIT_PULL}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(GIT_FETCH, async (_event, cwd: string, remote?: string) => {
    try {
      const git = simpleGit(validateCwd(cwd))
      await git.fetch(remote || 'origin')
    } catch (error) {
      log.error(`[${GIT_FETCH}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(GIT_LOG, async (_event, cwd: string, maxCount?: number) => {
    try {
      const git = simpleGit(validateCwd(cwd))
      const log = await git.log({ maxCount: maxCount || 50 })
      return log.all.map((entry) => ({
        hash: entry.hash,
        message: entry.message,
        author_name: entry.author_name,
        author_email: entry.author_email,
        date: entry.date,
      }))
    } catch (error) {
      log.error(`[${GIT_LOG}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(GIT_BRANCH_LIST, async (_event, cwd: string) => {
    try {
      const git = simpleGit(validateCwd(cwd))
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
    } catch (error) {
      log.error(`[${GIT_BRANCH_LIST}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(
    GIT_BRANCH_CREATE,
    async (_event, cwd: string, branchName: string, startPoint?: string) => {
      try {
        await createBranch(cwd, branchName, startPoint)
      } catch (error) {
        log.error(`[${GIT_BRANCH_CREATE}]`, error)
        throw error instanceof Error ? error : new Error(String(error))
      }
    },
  )

  ipcMain.handle(
    GIT_BRANCH_DELETE,
    async (_event, cwd: string, branchName: string, force?: boolean) => {
      try {
        const git = simpleGit(validateCwd(cwd))
        if (force) {
          await git.branch(['-D', branchName])
        } else {
          await git.branch(['-d', branchName])
        }
      } catch (error) {
        log.error(`[${GIT_BRANCH_DELETE}]`, error)
        throw error instanceof Error ? error : new Error(String(error))
      }
    },
  )

  ipcMain.handle(GIT_CHECKOUT, async (_event, cwd: string, branchName: string) => {
    try {
      const git = simpleGit(validateCwd(cwd))
      await git.checkout(branchName)
    } catch (error) {
      log.error(`[${GIT_CHECKOUT}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(GIT_DIFF_STAGED, async (_event, cwd: string, filePath?: string) => {
    try {
      const validCwd = validateCwd(cwd)
      const git = simpleGit(validCwd)
      if (filePath) {
        return await git.diff(['--cached', validateFilePath(validCwd, filePath)])
      }
      return await git.diff(['--cached'])
    } catch (error) {
      log.error(`[${GIT_DIFF_STAGED}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(GIT_STASH, async (_event, cwd: string, message?: string) => {
    try {
      const git = simpleGit(validateCwd(cwd))
      if (message) {
        await git.stash(['push', '-m', message])
      } else {
        await git.stash()
      }
    } catch (error) {
      log.error(`[${GIT_STASH}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(GIT_STASH_POP, async (_event, cwd: string) => {
    try {
      const git = simpleGit(validateCwd(cwd))
      await git.stash(['pop'])
    } catch (error) {
      log.error(`[${GIT_STASH_POP}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(GIT_DISCARD_FILE, async (_event, cwd: string, filePath: string) => {
    try {
      const validCwd = validateCwd(cwd)
      const git = simpleGit(validCwd)
      await git.checkout(['--', validateFilePath(validCwd, filePath)])
    } catch (error) {
      log.error(`[${GIT_DISCARD_FILE}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(GIT_WORKTREE_LIST, async (_event, cwd: string) => {
    try {
      const git = simpleGit(validateCwd(cwd))
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
          // Allowlist the worktree path so post-restart terminal/agent spawns
          // succeed without the user needing to open the Parallel Work tab.
          if (!isBare) addAllowedRoot(wtPath)
        }
      }
      return worktrees
    } catch {
      return []
    }
  })

  // ---------------------------------------------------------------------------
  // Worktree mutation handlers — used by the Parallel Work sidebar tab.
  // ---------------------------------------------------------------------------

  ipcMain.handle(
    GIT_WORKTREE_ADD,
    async (
      _event,
      repoCwd: string,
      branch: string,
      targetPath: string,
      options?: { createBranch?: boolean; baseRef?: string },
    ) => {
      try {
        const validRepo = validateCwd(repoCwd)
        const git = simpleGit(validRepo)
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        const args = ['worktree', 'add']
        if (options?.createBranch) {
          args.push('-b', branch, targetPath, options.baseRef ?? 'HEAD')
        } else {
          args.push(targetPath, branch)
        }
        await git.raw(args)
        // Worktree dirs sit at <repo>/../<repo>.worktrees/<branch>, outside
        // the workspace's primary rootPath. Whitelist them so terminals/agents
        // can spawn with the worktree as cwd without tripping validateCwd.
        addAllowedRoot(targetPath)
        return { path: targetPath, branch }
      } catch (error) {
        log.error(`[${GIT_WORKTREE_ADD}]`, error)
        throw error instanceof Error ? error : new Error(String(error))
      }
    },
  )

  ipcMain.handle(
    GIT_WORKTREE_REMOVE,
    async (_event, repoCwd: string, worktreePath: string, options?: { force?: boolean }) => {
      try {
        const validRepo = validateCwd(repoCwd)
        const git = simpleGit(validRepo)
        const args = ['worktree', 'remove']
        if (options?.force) args.push('--force')
        args.push(worktreePath)
        await git.raw(args)
        await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {})
        removeAllowedRoot(worktreePath)
      } catch (error) {
        log.error(`[${GIT_WORKTREE_REMOVE}]`, error)
        throw error instanceof Error ? error : new Error(String(error))
      }
    },
  )

  ipcMain.handle(GIT_WORKTREE_PRUNE, async (_event, repoCwd: string) => {
    try {
      const git = simpleGit(validateCwd(repoCwd))
      const output = await git.raw(['worktree', 'prune', '-v'])
      return { output }
    } catch (error) {
      log.error(`[${GIT_WORKTREE_PRUNE}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(GIT_WORKTREE_STATUS, async (_event, worktreePath: string) => {
    try {
      const git = simpleGit(validateCwd(worktreePath))
      const status = await git.status()
      let ahead = 0
      let behind = 0
      if (status.tracking) {
        try {
          const counts = await git.raw(['rev-list', '--left-right', '--count', `${status.tracking}...HEAD`])
          const [b, a] = counts.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0)
          behind = b ?? 0
          ahead = a ?? 0
        } catch {
          // tracking ref may not exist locally; leave 0/0
        }
      }
      return {
        branch: status.current ?? '',
        dirty: status.files.length > 0,
        ahead,
        behind,
        staged: status.staged.length,
        unstaged: status.modified.length + status.deleted.length,
        untracked: status.not_added.length,
      }
    } catch (error) {
      log.error(`[${GIT_WORKTREE_STATUS}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(
    GIT_WORKTREE_MERGE_TO,
    async (_event, repoCwd: string, fromBranch: string, toBranch: string) => {
      try {
        const git = simpleGit(validateCwd(repoCwd))
        await git.fetch()
        await git.checkout(toBranch)
        const result = await git.merge([fromBranch, '--no-edit'])
        return { ok: true, result }
      } catch (error) {
        log.error(`[${GIT_WORKTREE_MERGE_TO}]`, error)
        const msg = error instanceof Error ? error.message : String(error)
        // Surface conflict as structured error so the renderer can react.
        const isConflict = /CONFLICT|conflict/.test(msg)
        return { ok: false, conflict: isConflict, message: msg }
      }
    },
  )
}
