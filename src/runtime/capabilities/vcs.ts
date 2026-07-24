// =============================================================================
// Vcs capability — electron-free git operations (simple-git + gh), built as a
// factory so the env source can be injected: the Electron side passes
// getShellEnv(), the standalone daemon passes process.env. No electron-log /
// settings / window imports, so it bundles into the daemon. Validation +
// allowed-root mutation use the electron-free pathValidation module.
//
// Behavior mirrors src/main/ipc/git.ts (the local path); the only differences
// are (a) env is injected and (b) log+rethrow wrappers are dropped — the
// RpcServer/IPC layer reports errors. Behavioral catches that return []/null/
// false are preserved exactly.
// =============================================================================

import { simpleGit } from 'simple-git'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fsp from 'fs/promises'
import path from 'path'
import {
  validateCwd as validateScopedCwd,
  addAllowedRootForRelatedPath,
  removeAllowedRootFromAllScopes,
} from '../../main/ipc/pathValidation'
import { ensureCateGitignore } from '../../main/cateGitignore'
import type { FileAccessContext, VcsHost } from '../../main/runtime/types'

const execFileP = promisify(execFile)

/** Best-effort symlink of workspace-root-relative paths (e.g. node_modules,
 *  build output) from the source checkout into a freshly created worktree, so
 *  heavy artifacts don't need reinstalling per worktree. Each entry is resolved
 *  relative to the source root; absolute or parent-escaping entries and missing
 *  sources are skipped. Existing files in the worktree are never clobbered, and
 *  a single failure never aborts worktree creation. */
async function linkWorktreePaths(
  sourceRoot: string,
  worktreePath: string,
  relPaths: string[] | undefined,
): Promise<void> {
  for (const raw of relPaths ?? []) {
    const rel = raw.trim().replace(/^[/\\]+/, '')
    if (!rel || rel.split(/[/\\]/).includes('..')) continue
    const src = path.join(sourceRoot, rel)
    const dest = path.join(worktreePath, rel)
    try {
      const stat = await fsp.stat(src) // follows links; source must exist
      const occupied = await fsp.lstat(dest).then(() => true, () => false)
      if (occupied) continue
      await fsp.mkdir(path.dirname(dest), { recursive: true })
      await fsp.symlink(src, dest, stat.isDirectory() ? 'junction' : 'file')
    } catch {
      // Source missing or link failed — skip this entry silently.
    }
  }
}

export interface VcsCapabilityDeps {
  /** Environment for `git`/`gh` subprocesses (login-shell PATH locally). */
  env: () => NodeJS.ProcessEnv
  /** Runtime-owned scope, used only as the FALLBACK for registering discovered
   *  worktree roots when no workspace scope owns the source repo yet. Every cwd
   *  is validated against the CALLER's scope (access.scopeId), never this. */
  scopeId: string
}

// Every git op fails with a raw `spawn git ENOENT` on a host without git — the
// only runtime dependency that is NOT bundled into the tarball (node, rg, pi
// are). Detect that case and replace it with an actionable message; a probe
// failure is not cached, so installing git mid-session recovers on the next op.
const GIT_MISSING_MESSAGE =
  'git was not found on this host. Install git (and re-open the workspace if needed) to use source control.'

function looksLikeMissingGit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('spawn git ENOENT') || /'git' is not recognized/i.test(msg)
}

/** Wrap every VcsHost method: when an op fails in the shape of a missing git
 *  binary AND a `git --version` probe confirms it, throw the clear message
 *  instead of the raw spawn error. Anything else rethrows untouched. */
function guardGitMissing(host: VcsHost, env: () => NodeJS.ProcessEnv): VcsHost {
  let probe: Promise<boolean> | null = null
  const gitAvailable = (): Promise<boolean> =>
    (probe ??= execFileP('git', ['--version'], { env: env() }).then(
      () => true,
      () => {
        probe = null // re-probe next time: installing git recovers without a reconnect
        return false
      },
    ))
  const guarded = {} as Record<string, unknown>
  for (const [key, method] of Object.entries(host)) {
    guarded[key] = async (...args: unknown[]) => {
      try {
        return await (method as (...a: unknown[]) => Promise<unknown>)(...args)
      } catch (err) {
        if (looksLikeMissingGit(err) && !(await gitAvailable())) {
          throw new Error(GIT_MISSING_MESSAGE)
        }
        throw err
      }
    }
  }
  return guarded as unknown as VcsHost
}

export function createVcsCapability(deps: VcsCapabilityDeps): VcsHost {
  const env = () => deps.env()
  // Validate the cwd against the calling workspace's scope. No fallback to the
  // runtime's own scope: an op that names no workspace scope is rejected, so a
  // workspace can never run git against a repo outside its registered roots.
  const validateCwd = (cwd: string, access?: FileAccessContext) =>
    validateScopedCwd(cwd, access?.ownerWindowId, access?.scopeId)
  const addWorktreeRoot = (root: string, repoCwd: string) =>
    addAllowedRootForRelatedPath(root, repoCwd, deps.scopeId)

  function validateFilePath(cwd: string, filePath: string): string {
    const resolvedCwd = path.resolve(cwd)
    const resolved = path.resolve(cwd, filePath)
    if (resolved !== resolvedCwd && !resolved.startsWith(resolvedCwd + path.sep)) {
      throw new Error('filePath escapes workspace')
    }
    return path.relative(cwd, resolved)
  }

  async function isGitRepo(dirPath: string): Promise<boolean> {
    try {
      await fsp.access(path.join(dirPath, '.git'))
      return true
    } catch {
      return false
    }
  }

  // Directory names we never descend into while scanning for sub-repos: heavy
  // build/vendor output that can't itself be a workspace repo we'd surface.
  // (Repos we DO find are never descended into either — see findReposFrom.)
  const SCAN_SKIP_DIRS = new Set([
    'node_modules', 'dist', 'build', 'out', 'target', 'vendor',
    '.git', '.cache', '.next', '.turbo', '.venv', 'venv', '__pycache__',
  ])

  /** Recursively collect git-repo directories at or below `dir`, descending at
   *  most `maxDepth` levels and stopping at each repo (so we never walk into a
   *  found repo's own tree, node_modules, or dot-directories). `depth` is how
   *  many levels below the original root `dir` sits. */
  async function findReposFrom(dir: string, depth: number, maxDepth: number, out: string[]): Promise<void> {
    if (await isGitRepo(dir)) {
      out.push(dir)
      return // a repo is a leaf for discovery — don't descend into it
    }
    if (depth >= maxDepth) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable dir — skip silently
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || SCAN_SKIP_DIRS.has(entry.name)) continue
      await findReposFrom(path.join(dir, entry.name), depth + 1, maxDepth, out)
    }
  }

  async function ghAvailable(cwd: string): Promise<boolean> {
    try {
      await execFileP('gh', ['--version'], { cwd, timeout: 5000, env: env() })
      return true
    } catch {
      return false
    }
  }

  async function availablePrBranch(git: ReturnType<typeof simpleGit>, prNumber: number): Promise<string> {
    const base = `cate-pr-${prNumber}`
    const existing = new Set((await git.branchLocal()).all)
    const conflicts = (candidate: string) =>
      existing.has(candidate) || [...existing].some((branch) => branch.startsWith(`${candidate}/`))
    let branch = base
    for (let suffix = 2; conflicts(branch); suffix += 1) branch = `${base}-${suffix}`
    return branch
  }

  function prCheckoutError(prNumber: number, error: unknown): Error {
    const detail = [
      error instanceof Error ? error.message : String(error),
      typeof error === 'object' && error && 'stderr' in error ? String(error.stderr) : '',
    ].join('\n')
    if (/authentication|not authenticated|auth login|not logged|HTTP 401|HTTP 403/i.test(detail)) {
      return new Error(`GitHub CLI isn’t authenticated. Run “gh auth login”, then try PR #${prNumber} again.`)
    }
    if (/could not resolve to a pull request|no pull requests found|pull request.*not found/i.test(detail)) {
      return new Error(`Pull request #${prNumber} could not be found. It may have been closed or removed.`)
    }
    if (/ETIMEDOUT|timed out|network|ENOTFOUND|ECONNRESET|could not resolve host/i.test(detail)) {
      return new Error(`Couldn’t reach GitHub while checking out PR #${prNumber}. Check your connection and try again.`)
    }
    return new Error(`Couldn’t check out PR #${prNumber}. Check that GitHub CLI can access this repository, then try again.`)
  }

  async function ensureContainingDir(targetPath: string): Promise<void> {
    const containingDir = path.dirname(targetPath)
    await fsp.mkdir(containingDir, { recursive: true })
    await ensureCateGitignore(path.dirname(containingDir))
  }

  async function compareUrlFor(git: ReturnType<typeof simpleGit>, branch: string): Promise<string | null> {
    try {
      const remote = (await git.raw(['remote', 'get-url', 'origin'])).trim()
      const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/)
      if (!m) return null
      return `https://github.com/${m[1]}/compare/${encodeURIComponent(branch)}?expand=1`
    } catch {
      return null
    }
  }

  const host: VcsHost = {
    async isRepo(dir, access) {
      return isGitRepo(validateCwd(dir, access))
    },
    async findRepos(dir, maxDepth, access) {
      const out: string[] = []
      await findReposFrom(validateCwd(dir, access), 0, Math.max(1, maxDepth ?? 1), out)
      return out
    },
    async init(dir, access) {
      await simpleGit(validateCwd(dir, access)).init()
    },
    async lsFiles(dir, access) {
      try {
        const result = await simpleGit(validateCwd(dir, access)).raw([
          'ls-files', '--cached', '--others', '--exclude-standard',
        ])
        return result.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
      } catch {
        return []
      }
    },
    async status(cwd, access) {
      const status = await simpleGit(validateCwd(cwd, access)).status()
      return {
        files: status.files.map((f) => ({ path: f.path, index: f.index, working_dir: f.working_dir })),
        current: status.current,
        tracking: status.tracking,
        ahead: status.ahead,
        behind: status.behind,
      }
    },
    async diff(cwd, filePath, access) {
      const validCwd = validateCwd(cwd, access)
      const git = simpleGit(validCwd)
      return filePath ? git.diff([validateFilePath(validCwd, filePath)]) : git.diff()
    },
    async diffStaged(cwd, filePath, access) {
      const validCwd = validateCwd(cwd, access)
      const git = simpleGit(validCwd)
      return filePath ? git.diff(['--cached', validateFilePath(validCwd, filePath)]) : git.diff(['--cached'])
    },
    async monitorStatus(cwd, access) {
      // Mirrors git-monitor.ts's old raw-git poll exactly: current branch,
      // dirty flag (tracked-only, -uno), and the local branch name list. Runs
      // on whichever host this capability lives on (local or daemon), so a
      // remote workspace's sidebar indicator now reflects the remote repo.
      const validCwd = validateCwd(cwd, access)
      const run = (args: string[]) =>
        execFileP('git', ['-C', validCwd, ...args], { timeout: 3000, env: env() })
          .then((r) => r.stdout)
      const [branchOut, statusOut, branchesOut] = await Promise.all([
        run(['branch', '--show-current']),
        run(['status', '--porcelain', '-uno']),
        run(['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      ])
      const branch = branchOut.trim()
      return {
        branch: branch || null,
        dirty: statusOut.trim().length > 0,
        branches: branchesOut.split('\n').map((s) => s.trim()).filter(Boolean),
      }
    },
    async stage(cwd, filePath, access) {
      const validCwd = validateCwd(cwd, access)
      await simpleGit(validCwd).add(validateFilePath(validCwd, filePath))
    },
    async unstage(cwd, filePath, access) {
      const validCwd = validateCwd(cwd, access)
      await simpleGit(validCwd).reset([validateFilePath(validCwd, filePath)])
    },
    async commit(cwd, message, access) {
      await simpleGit(validateCwd(cwd, access)).commit(message)
    },
    async push(cwd, remote, branch, access) {
      await simpleGit(validateCwd(cwd, access)).push(remote || 'origin', branch)
    },
    async pull(cwd, remote, branch, access) {
      const result = await simpleGit(validateCwd(cwd, access)).pull(remote || 'origin', branch)
      return {
        summary: {
          changes: result.summary.changes,
          insertions: result.summary.insertions,
          deletions: result.summary.deletions,
        },
      }
    },
    async fetch(cwd, remote, access) {
      await simpleGit(validateCwd(cwd, access)).fetch(remote || 'origin')
    },
    async log(cwd, maxCount, access) {
      const logResult = await simpleGit(validateCwd(cwd, access)).log({ maxCount: maxCount || 50 })
      return logResult.all.map((e) => ({
        hash: e.hash, message: e.message, author_name: e.author_name, author_email: e.author_email, date: e.date,
      }))
    },
    async branchList(cwd, access) {
      const result = await simpleGit(validateCwd(cwd, access)).branch(['-a', '--sort=-committerdate'])
      return {
        current: result.current,
        branches: Object.entries(result.branches).map(([name, info]) => ({
          name, current: info.current, commit: info.commit, label: info.label, isRemote: name.startsWith('remotes/'),
        })),
      }
    },
    async branchCreate(cwd, name, startPoint, access) {
      const git = simpleGit(validateCwd(cwd, access))
      if (startPoint) await git.checkoutBranch(name, startPoint)
      else await git.checkoutLocalBranch(name)
    },
    async branchDelete(cwd, name, force, access) {
      await simpleGit(validateCwd(cwd, access)).branch([force ? '-D' : '-d', name])
    },
    async checkout(cwd, branch, access) {
      await simpleGit(validateCwd(cwd, access)).checkout(branch)
    },
    async stash(cwd, message, access) {
      const git = simpleGit(validateCwd(cwd, access))
      if (message) await git.stash(['push', '-m', message])
      else await git.stash()
    },
    async stashPop(cwd, access) {
      await simpleGit(validateCwd(cwd, access)).stash(['pop'])
    },
    async discardFile(cwd, filePath, access) {
      const validCwd = validateCwd(cwd, access)
      await simpleGit(validCwd).checkout(['--', validateFilePath(validCwd, filePath)])
    },
    async worktreeList(cwd, access) {
      try {
        // Normalize CRLF first: Git for Windows can emit \r\n depending on the
        // user's core.autocrlf/eol config, and a trailing \r would otherwise
        // ride along on every parsed path/branch and break later path matching.
        const raw = (await simpleGit(validateCwd(cwd, access)).raw(['worktree', 'list', '--porcelain'])).replace(/\r\n/g, '\n')
        const worktrees = []
        for (const block of raw.trim().split('\n\n')) {
          let wtPath = '', branch = '', isBare = false
          for (const line of block.split('\n')) {
            if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length)
            else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace('refs/heads/', '')
            else if (line === 'bare') isBare = true
            else if (line.startsWith('HEAD ') && !branch) branch = line.slice('HEAD '.length).substring(0, 8)
          }
          if (wtPath) {
            worktrees.push({ path: wtPath, branch: branch || '(unknown)', isBare, isCurrent: path.resolve(wtPath) === path.resolve(cwd) })
            if (!isBare) addWorktreeRoot(wtPath, cwd)
          }
        }
        return worktrees
      } catch {
        return []
      }
    },
    async worktreeAdd(repoCwd, branch, targetPath, options, access) {
      const git = simpleGit(validateCwd(repoCwd, access))
      await ensureContainingDir(targetPath)
      const args = ['worktree', 'add']
      if (options?.createBranch) args.push('-b', branch, targetPath, options.baseRef ?? 'HEAD')
      else args.push(targetPath, branch)
      await git.raw(args)
      addWorktreeRoot(targetPath, repoCwd)
      await linkWorktreePaths(validateCwd(repoCwd, access), targetPath, options?.symlinkPaths)
      return { path: targetPath, branch }
    },
    async worktreeAddFromPr(repoCwd, prNumber, targetPath, options, access) {
      const validRepo = validateCwd(repoCwd, access)
      const git = simpleGit(validRepo)
      if (!(await ghAvailable(validRepo))) throw new Error('GitHub CLI (gh) is required to check out pull requests.')
      await ensureContainingDir(targetPath)
      const branch = await availablePrBranch(git, prNumber)
      try {
        await git.raw(['worktree', 'add', '--detach', targetPath])
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        if (/already exists|already checked out|already registered/i.test(detail)) {
          throw new Error(`A worktree for PR #${prNumber} already exists. Remove it or run Clean up, then try again.`)
        }
        throw new Error(`Couldn’t create a worktree for PR #${prNumber}. Check that the repository is writable and try again.`)
      }
      addWorktreeRoot(targetPath, repoCwd)
      try {
        // Never let gh reuse the contributor's local branch: it may have
        // diverged, be checked out elsewhere, or contain unpublished work.
        await execFileP('gh', ['pr', 'checkout', String(prNumber), '--branch', branch], {
          cwd: targetPath,
          timeout: 120000,
          env: env(),
        })
      } catch (error) {
        await git.raw(['worktree', 'remove', '--force', targetPath]).catch(() => {})
        await git.branch(['-D', branch]).catch(() => {})
        await fsp.rm(targetPath, { recursive: true, force: true }).catch(() => {})
        removeAllowedRootFromAllScopes(targetPath)
        throw prCheckoutError(prNumber, error)
      }
      await linkWorktreePaths(validRepo, targetPath, options?.symlinkPaths)
      return { path: targetPath, branch }
    },
    async worktreeRemove(repoCwd, worktreePath, options, access) {
      const git = simpleGit(validateCwd(repoCwd, access))
      const args = ['worktree', 'remove']
      if (options?.force) args.push('--force')
      args.push(worktreePath)
      await git.raw(args)
      await fsp.rm(worktreePath, { recursive: true, force: true }).catch(() => {})
      removeAllowedRootFromAllScopes(worktreePath)
    },
    async worktreePrune(repoCwd, access) {
      const output = await simpleGit(validateCwd(repoCwd, access)).raw(['worktree', 'prune', '-v'])
      return { output }
    },
    async worktreeStatus(worktreePath, access) {
      try {
        const stat = await fsp.stat(worktreePath)
        if (!stat.isDirectory()) return null
      } catch {
        return null
      }
      const git = simpleGit(validateCwd(worktreePath, access))
      if (!(await git.checkIsRepo())) return null
      const status = await git.status()
      let ahead = 0, behind = 0
      if (status.tracking) {
        try {
          const counts = await git.raw(['rev-list', '--left-right', '--count', `${status.tracking}...HEAD`])
          const [b, a] = counts.trim().split(/\s+/).map((x) => parseInt(x, 10) || 0)
          behind = b ?? 0
          ahead = a ?? 0
        } catch { /* leave 0/0 */ }
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
    },
    async worktreeMergeTo(repoCwd, fromBranch, toBranch, access) {
      const git = simpleGit(validateCwd(repoCwd, access))
      try {
        if ((await git.status()).files.length > 0) {
          return {
            ok: false,
            conflict: false,
            message: `Commit or stash changes in ${toBranch} before merging into it.`,
          }
        }
        await git.checkout(toBranch)
        const result = await git.merge([fromBranch, '--no-edit'])
        return { ok: true, result }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        const mergeInProgress = await git.raw(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(
          () => true,
          () => false,
        )
        if (/CONFLICT|conflict/.test(msg) || mergeInProgress) {
          const aborted = await git.raw(['merge', '--abort']).then(
            () => true,
            () => false,
          )
          return {
            ok: false,
            conflict: true,
            message: aborted
              ? 'The branches have conflicting changes. The merge was aborted.'
              : `The branches have conflicting changes. Open a terminal in ${toBranch} to resolve or abort the merge.`,
          }
        }
        return {
          ok: false,
          conflict: false,
          message: `Couldn’t merge ${fromBranch} into ${toBranch}. Make sure both branches still exist.`,
        }
      }
    },
    async worktreeUpdateFrom(worktreePath, fromBranch, access) {
      try {
        const git = simpleGit(validateCwd(worktreePath, access))
        if ((await git.status()).files.length > 0) {
          return {
            ok: false,
            conflict: false,
            message: `Commit or stash changes before updating from ${fromBranch}.`,
          }
        }
        await git.fetch().catch(() => {})
        const result = await git.merge([fromBranch, '--no-edit'])
        return { ok: true, result }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        const conflict = /CONFLICT|conflict/.test(msg)
        return {
          ok: false,
          conflict,
          message: conflict
            ? 'The branches have conflicting changes.'
            : `Couldn’t update from ${fromBranch}. Make sure the branch still exists.`,
        }
      }
    },
    async createPr(worktreePath, branch, access) {
      const cwd = validateCwd(worktreePath, access)
      const git = simpleGit(cwd)
      try {
        await git.push(['-u', 'origin', branch])
      } catch (error) {
        return { ok: false, message: `Push failed: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (await ghAvailable(cwd)) {
        try {
          const { stdout } = await execFileP('gh', ['pr', 'create', '--fill', '--head', branch], { cwd, timeout: 60000, env: env() })
          return { ok: true, created: true, url: stdout.trim().split('\n').filter(Boolean).pop() ?? '' }
        } catch {
          try {
            const { stdout } = await execFileP('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], { cwd, timeout: 10000, env: env() })
            const url = stdout.trim()
            if (url) return { ok: true, created: false, url }
          } catch { /* fall through */ }
        }
      }
      const url = await compareUrlFor(git, branch)
      if (url) return { ok: true, created: false, url, fallback: true }
      return { ok: false, message: 'Pushed, but could not determine the GitHub URL (no origin remote?).' }
    },
    async prStatus(worktreePath, branch, access) {
      try {
        const cwd = validateCwd(worktreePath, access)
        if (!(await ghAvailable(cwd))) return null
        const { stdout } = await execFileP('gh', ['pr', 'view', branch, '--json', 'number,state,url,isDraft'], { cwd, timeout: 10000, env: env() })
        const data = JSON.parse(stdout) as { number: number; state: string; url: string; isDraft: boolean }
        return { number: data.number, state: data.state, url: data.url, isDraft: data.isDraft }
      } catch {
        return null
      }
    },
    async prList(repoCwd, access) {
      try {
        const cwd = validateCwd(repoCwd, access)
        if (!(await ghAvailable(cwd))) return []
        const { stdout } = await execFileP('gh', ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,headRefName,author,isCrossRepository'], { cwd, timeout: 15000, env: env() })
        const arr = JSON.parse(stdout) as Array<{ number: number; title: string; headRefName: string; author?: { login?: string }; isCrossRepository?: boolean }>
        return arr.map((p) => ({ number: p.number, title: p.title, headRefName: p.headRefName, author: p.author?.login ?? '', isFork: !!p.isCrossRepository }))
      } catch {
        return []
      }
    },
  }
  return guardGitMissing(host, env)
}
