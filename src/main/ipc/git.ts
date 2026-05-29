// =============================================================================
// Git IPC handlers — repository detection and file listing
// =============================================================================

import { simpleGit } from 'simple-git'
import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import log from '../logger'
import fs from 'fs/promises'
import path from 'path'
import { validateCwd, addAllowedRoot, removeAllowedRoot } from './pathValidation'
import {
  GIT_IS_REPO,
  GIT_INIT,
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
  GIT_WORKTREE_ADD_FROM_PR,
  GIT_WORKTREE_UPDATE_FROM,
  GIT_CREATE_PR,
  GIT_PR_STATUS,
  GIT_PR_LIST,
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

const execFileP = promisify(execFile)

/** Whether the GitHub CLI is installed and runnable from `cwd`. */
async function ghAvailable(cwd: string): Promise<boolean> {
  try {
    await execFileP('gh', ['--version'], { cwd, timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/** Create a worktree's containing dir and drop a self-ignoring `*` .gitignore
 *  so the checkouts under .cate/worktrees never show as untracked in the parent
 *  repo. Best-effort; the .gitignore is written only when absent. */
async function ensureContainingDir(targetPath: string): Promise<void> {
  const containingDir = path.dirname(targetPath)
  await fs.mkdir(containingDir, { recursive: true })
  const ignorePath = path.join(containingDir, '.gitignore')
  try {
    await fs.access(ignorePath)
  } catch {
    await fs.writeFile(ignorePath, '*\n').catch(() => {})
  }
}

/** Build a github.com compare URL from the repo's `origin` remote so a PR can
 *  be opened in the browser even when the `gh` CLI isn't installed. */
async function compareUrlFor(git: ReturnType<typeof simpleGit>, branch: string): Promise<string | null> {
  try {
    const remote = (await git.raw(['remote', 'get-url', 'origin'])).trim()
    // git@github.com:owner/repo.git  or  https://github.com/owner/repo(.git)
    const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/)
    if (!m) return null
    return `https://github.com/${m[1]}/compare/${encodeURIComponent(branch)}?expand=1`
  } catch {
    return null
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

  ipcMain.handle(GIT_INIT, async (_event, dirPath: string) => {
    try {
      const git = simpleGit(validateCwd(dirPath))
      await git.init()
    } catch (error) {
      log.error(`[${GIT_INIT}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
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
        await ensureContainingDir(targetPath)
        const args = ['worktree', 'add']
        if (options?.createBranch) {
          args.push('-b', branch, targetPath, options.baseRef ?? 'HEAD')
        } else {
          args.push(targetPath, branch)
        }
        await git.raw(args)
        // The worktree dir sits under .cate/, which isn't a tracked path the
        // workspace validator knows about — whitelist it so terminals/agents
        // can spawn with the worktree as cwd without tripping validateCwd.
        addAllowedRoot(targetPath)
        return { path: targetPath, branch }
      } catch (error) {
        log.error(`[${GIT_WORKTREE_ADD}]`, error)
        throw error instanceof Error ? error : new Error(String(error))
      }
    },
  )

  // Check out an open pull request (including contributors' fork branches) into
  // its own worktree. We create a detached worktree, then let `gh pr checkout`
  // adopt the PR branch inside it — gh wires up the fork remote + upstream so
  // commits can be pushed back to update the PR.
  ipcMain.handle(
    GIT_WORKTREE_ADD_FROM_PR,
    async (_event, repoCwd: string, prNumber: number, targetPath: string) => {
      const validRepo = validateCwd(repoCwd)
      const git = simpleGit(validRepo)
      if (!(await ghAvailable(validRepo))) {
        throw new Error('GitHub CLI (gh) is required to check out pull requests.')
      }
      await ensureContainingDir(targetPath)
      await git.raw(['worktree', 'add', '--detach', targetPath])
      addAllowedRoot(targetPath)
      try {
        await execFileP('gh', ['pr', 'checkout', String(prNumber)], {
          cwd: targetPath,
          timeout: 120000,
        })
      } catch (error) {
        // Roll back the half-created worktree so we never leave an orphan.
        await git.raw(['worktree', 'remove', '--force', targetPath]).catch(() => {})
        await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {})
        removeAllowedRoot(targetPath)
        const msg = error instanceof Error ? error.message : String(error)
        throw new Error(`Could not check out PR #${prNumber}: ${msg}`)
      }
      const branch = (await simpleGit(targetPath).raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      return { path: targetPath, branch }
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
      // After a worktree is removed (or its directory deleted out-of-band),
      // a stale status request may still arrive before the renderer refreshes
      // its list. Treat "path missing" / "not a repo" as a soft no-op so we
      // don't spam the log with confusing GitErrors.
      try {
        const stat = await fs.stat(worktreePath)
        if (!stat.isDirectory()) return null
      } catch {
        return null
      }
      const git = simpleGit(validateCwd(worktreePath))
      if (!(await git.checkIsRepo())) return null
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

  // Pull the latest primary branch into a worktree's own branch, run inside the
  // worktree so the primary checkout is never disturbed. Offline-friendly: a
  // missing remote just skips the fetch and merges the local primary branch.
  ipcMain.handle(
    GIT_WORKTREE_UPDATE_FROM,
    async (_event, worktreePath: string, fromBranch: string) => {
      try {
        const git = simpleGit(validateCwd(worktreePath))
        await git.fetch().catch(() => {})
        const result = await git.merge([fromBranch, '--no-edit'])
        return { ok: true, result }
      } catch (error) {
        log.error(`[${GIT_WORKTREE_UPDATE_FROM}]`, error)
        const msg = error instanceof Error ? error.message : String(error)
        const isConflict = /CONFLICT|conflict/.test(msg)
        return { ok: false, conflict: isConflict, message: msg }
      }
    },
  )

  // Open (or locate) a GitHub pull request for a worktree's branch. Pushes the
  // branch with upstream first, then prefers `gh pr create`; without `gh`, falls
  // back to a github.com compare URL the renderer can open in the browser.
  ipcMain.handle(GIT_CREATE_PR, async (_event, worktreePath: string, branch: string) => {
    const cwd = validateCwd(worktreePath)
    const git = simpleGit(cwd)
    try {
      await git.push(['-u', 'origin', branch])
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `Push failed: ${msg}` }
    }
    if (await ghAvailable(cwd)) {
      try {
        const { stdout } = await execFileP('gh', ['pr', 'create', '--fill', '--head', branch], {
          cwd,
          timeout: 60000,
        })
        const url = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
        return { ok: true, created: true, url }
      } catch {
        // A PR may already exist for this branch — return its URL instead.
        try {
          const { stdout } = await execFileP(
            'gh',
            ['pr', 'view', branch, '--json', 'url', '--jq', '.url'],
            { cwd, timeout: 10000 },
          )
          const url = stdout.trim()
          if (url) return { ok: true, created: false, url }
        } catch {
          /* fall through to the compare URL */
        }
      }
    }
    const url = await compareUrlFor(git, branch)
    if (url) return { ok: true, created: false, url, fallback: true }
    return { ok: false, message: 'Pushed, but could not determine the GitHub URL (no origin remote?).' }
  })

  // Cheap PR-status lookup for the sidebar pill. Returns null when `gh` is
  // absent or the branch has no PR — both are normal, so failures stay quiet.
  ipcMain.handle(GIT_PR_STATUS, async (_event, worktreePath: string, branch: string) => {
    try {
      const cwd = validateCwd(worktreePath)
      if (!(await ghAvailable(cwd))) return null
      const { stdout } = await execFileP(
        'gh',
        ['pr', 'view', branch, '--json', 'number,state,url,isDraft'],
        { cwd, timeout: 10000 },
      )
      const data = JSON.parse(stdout) as {
        number: number
        state: string
        url: string
        isDraft: boolean
      }
      return { number: data.number, state: data.state, url: data.url, isDraft: data.isDraft }
    } catch {
      return null
    }
  })

  // List open pull requests for the branch picker. Returns [] when `gh` is
  // absent or the repo has no GitHub remote, so the picker just omits the
  // section rather than erroring.
  ipcMain.handle(GIT_PR_LIST, async (_event, repoCwd: string) => {
    try {
      const cwd = validateCwd(repoCwd)
      if (!(await ghAvailable(cwd))) return []
      const { stdout } = await execFileP(
        'gh',
        ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,headRefName,author,isCrossRepository'],
        { cwd, timeout: 15000 },
      )
      const arr = JSON.parse(stdout) as Array<{
        number: number
        title: string
        headRefName: string
        author?: { login?: string }
        isCrossRepository?: boolean
      }>
      return arr.map((p) => ({
        number: p.number,
        title: p.title,
        headRefName: p.headRefName,
        author: p.author?.login ?? '',
        isFork: !!p.isCrossRepository,
      }))
    } catch {
      return []
    }
  })
}
