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
import { validateCwd, addAllowedRoot, removeAllowedRoot } from '../../main/ipc/pathValidation'
import { ensureCateGitignore } from '../../main/cateGitignore'
import type { VcsHost } from '../../main/runtime/types'

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
}

export function createVcsCapability(deps: VcsCapabilityDeps): VcsHost {
  const env = () => deps.env()

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

  async function ghAvailable(cwd: string): Promise<boolean> {
    try {
      await execFileP('gh', ['--version'], { cwd, timeout: 5000, env: env() })
      return true
    } catch {
      return false
    }
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

  return {
    async isRepo(dir) {
      return isGitRepo(validateCwd(dir))
    },
    async init(dir) {
      await simpleGit(validateCwd(dir)).init()
    },
    async lsFiles(dir) {
      try {
        const result = await simpleGit(validateCwd(dir)).raw([
          'ls-files', '--cached', '--others', '--exclude-standard',
        ])
        return result.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
      } catch {
        return []
      }
    },
    async status(cwd) {
      const status = await simpleGit(validateCwd(cwd)).status()
      return {
        files: status.files.map((f) => ({ path: f.path, index: f.index, working_dir: f.working_dir })),
        current: status.current,
        tracking: status.tracking,
        ahead: status.ahead,
        behind: status.behind,
      }
    },
    async diff(cwd, filePath) {
      const validCwd = validateCwd(cwd)
      const git = simpleGit(validCwd)
      return filePath ? git.diff([validateFilePath(validCwd, filePath)]) : git.diff()
    },
    async diffStaged(cwd, filePath) {
      const validCwd = validateCwd(cwd)
      const git = simpleGit(validCwd)
      return filePath ? git.diff(['--cached', validateFilePath(validCwd, filePath)]) : git.diff(['--cached'])
    },
    async monitorStatus(cwd) {
      // Mirrors git-monitor.ts's old raw-git poll exactly: current branch,
      // dirty flag (tracked-only, -uno), and the local branch name list. Runs
      // on whichever host this capability lives on (local or daemon), so a
      // remote workspace's sidebar indicator now reflects the remote repo.
      const validCwd = validateCwd(cwd)
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
    async stage(cwd, filePath) {
      const validCwd = validateCwd(cwd)
      await simpleGit(validCwd).add(validateFilePath(validCwd, filePath))
    },
    async unstage(cwd, filePath) {
      const validCwd = validateCwd(cwd)
      await simpleGit(validCwd).reset([validateFilePath(validCwd, filePath)])
    },
    async commit(cwd, message) {
      await simpleGit(validateCwd(cwd)).commit(message)
    },
    async push(cwd, remote, branch) {
      await simpleGit(validateCwd(cwd)).push(remote || 'origin', branch)
    },
    async pull(cwd, remote, branch) {
      const result = await simpleGit(validateCwd(cwd)).pull(remote || 'origin', branch)
      return {
        summary: {
          changes: result.summary.changes,
          insertions: result.summary.insertions,
          deletions: result.summary.deletions,
        },
      }
    },
    async fetch(cwd, remote) {
      await simpleGit(validateCwd(cwd)).fetch(remote || 'origin')
    },
    async log(cwd, maxCount) {
      const logResult = await simpleGit(validateCwd(cwd)).log({ maxCount: maxCount || 50 })
      return logResult.all.map((e) => ({
        hash: e.hash, message: e.message, author_name: e.author_name, author_email: e.author_email, date: e.date,
      }))
    },
    async branchList(cwd) {
      const result = await simpleGit(validateCwd(cwd)).branch(['-a', '--sort=-committerdate'])
      return {
        current: result.current,
        branches: Object.entries(result.branches).map(([name, info]) => ({
          name, current: info.current, commit: info.commit, label: info.label, isRemote: name.startsWith('remotes/'),
        })),
      }
    },
    async branchCreate(cwd, name, startPoint) {
      const git = simpleGit(validateCwd(cwd))
      if (startPoint) await git.checkoutBranch(name, startPoint)
      else await git.checkoutLocalBranch(name)
    },
    async branchDelete(cwd, name, force) {
      await simpleGit(validateCwd(cwd)).branch([force ? '-D' : '-d', name])
    },
    async checkout(cwd, branch) {
      await simpleGit(validateCwd(cwd)).checkout(branch)
    },
    async stash(cwd, message) {
      const git = simpleGit(validateCwd(cwd))
      if (message) await git.stash(['push', '-m', message])
      else await git.stash()
    },
    async stashPop(cwd) {
      await simpleGit(validateCwd(cwd)).stash(['pop'])
    },
    async discardFile(cwd, filePath) {
      const validCwd = validateCwd(cwd)
      await simpleGit(validCwd).checkout(['--', validateFilePath(validCwd, filePath)])
    },
    async worktreeList(cwd) {
      try {
        // Normalize CRLF first: Git for Windows can emit \r\n depending on the
        // user's core.autocrlf/eol config, and a trailing \r would otherwise
        // ride along on every parsed path/branch and break later path matching.
        const raw = (await simpleGit(validateCwd(cwd)).raw(['worktree', 'list', '--porcelain'])).replace(/\r\n/g, '\n')
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
            // TODO(scope): pass requesting workspace scope once threaded — legacy
            // (union) scope for now keeps worktree roots reachable.
            if (!isBare) addAllowedRoot(wtPath)
          }
        }
        return worktrees
      } catch {
        return []
      }
    },
    async worktreeAdd(repoCwd, branch, targetPath, options) {
      const git = simpleGit(validateCwd(repoCwd))
      await ensureContainingDir(targetPath)
      const args = ['worktree', 'add']
      if (options?.createBranch) args.push('-b', branch, targetPath, options.baseRef ?? 'HEAD')
      else args.push(targetPath, branch)
      await git.raw(args)
      // TODO(scope): pass requesting workspace scope once threaded.
      addAllowedRoot(targetPath)
      await linkWorktreePaths(validateCwd(repoCwd), targetPath, options?.symlinkPaths)
      return { path: targetPath, branch }
    },
    async worktreeAddFromPr(repoCwd, prNumber, targetPath, options) {
      const validRepo = validateCwd(repoCwd)
      const git = simpleGit(validRepo)
      if (!(await ghAvailable(validRepo))) throw new Error('GitHub CLI (gh) is required to check out pull requests.')
      await ensureContainingDir(targetPath)
      await git.raw(['worktree', 'add', '--detach', targetPath])
      // TODO(scope): pass requesting workspace scope once threaded.
      addAllowedRoot(targetPath)
      try {
        await execFileP('gh', ['pr', 'checkout', String(prNumber)], { cwd: targetPath, timeout: 120000, env: env() })
      } catch (error) {
        await git.raw(['worktree', 'remove', '--force', targetPath]).catch(() => {})
        await fsp.rm(targetPath, { recursive: true, force: true }).catch(() => {})
        removeAllowedRoot(targetPath)
        throw new Error(`Could not check out PR #${prNumber}: ${error instanceof Error ? error.message : String(error)}`)
      }
      const branch = (await simpleGit(targetPath).raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      await linkWorktreePaths(validRepo, targetPath, options?.symlinkPaths)
      return { path: targetPath, branch }
    },
    async worktreeRemove(repoCwd, worktreePath, options) {
      const git = simpleGit(validateCwd(repoCwd))
      const args = ['worktree', 'remove']
      if (options?.force) args.push('--force')
      args.push(worktreePath)
      await git.raw(args)
      await fsp.rm(worktreePath, { recursive: true, force: true }).catch(() => {})
      removeAllowedRoot(worktreePath)
    },
    async worktreePrune(repoCwd) {
      const output = await simpleGit(validateCwd(repoCwd)).raw(['worktree', 'prune', '-v'])
      return { output }
    },
    async worktreeStatus(worktreePath) {
      try {
        const stat = await fsp.stat(worktreePath)
        if (!stat.isDirectory()) return null
      } catch {
        return null
      }
      const git = simpleGit(validateCwd(worktreePath))
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
    async worktreeMergeTo(repoCwd, fromBranch, toBranch) {
      try {
        const git = simpleGit(validateCwd(repoCwd))
        await git.fetch()
        await git.checkout(toBranch)
        const result = await git.merge([fromBranch, '--no-edit'])
        return { ok: true, result }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { ok: false, conflict: /CONFLICT|conflict/.test(msg), message: msg }
      }
    },
    async worktreeUpdateFrom(worktreePath, fromBranch) {
      try {
        const git = simpleGit(validateCwd(worktreePath))
        await git.fetch().catch(() => {})
        const result = await git.merge([fromBranch, '--no-edit'])
        return { ok: true, result }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { ok: false, conflict: /CONFLICT|conflict/.test(msg), message: msg }
      }
    },
    async createPr(worktreePath, branch) {
      const cwd = validateCwd(worktreePath)
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
    async prStatus(worktreePath, branch) {
      try {
        const cwd = validateCwd(worktreePath)
        if (!(await ghAvailable(cwd))) return null
        const { stdout } = await execFileP('gh', ['pr', 'view', branch, '--json', 'number,state,url,isDraft'], { cwd, timeout: 10000, env: env() })
        const data = JSON.parse(stdout) as { number: number; state: string; url: string; isDraft: boolean }
        return { number: data.number, state: data.state, url: data.url, isDraft: data.isDraft }
      } catch {
        return null
      }
    },
    async prList(repoCwd) {
      try {
        const cwd = validateCwd(repoCwd)
        if (!(await ghAvailable(cwd))) return []
        const { stdout } = await execFileP('gh', ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,headRefName,author,isCrossRepository'], { cwd, timeout: 15000, env: env() })
        const arr = JSON.parse(stdout) as Array<{ number: number; title: string; headRefName: string; author?: { login?: string }; isCrossRepository?: boolean }>
        return arr.map((p) => ({ number: p.number, title: p.title, headRefName: p.headRefName, author: p.author?.login ?? '', isFork: !!p.isCrossRepository }))
      } catch {
        return []
      }
    },
  }
}
