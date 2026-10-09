// Git on the runtime's host (simple-git plus `gh` for PR checkouts). Every
// directory is resolved through the workspace path scope first.

import { simpleGit, type SimpleGit } from 'simple-git'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fsp from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import type { ParamsOf, ResultOf } from '@kernel/rpc/contract'
import type {
  GitChangedFile,
  GitChangeStatus,
  GitComparisonSpec,
  GitWorktree,
  VcsCapability,
} from '../contract'
import { NotARepositoryError, githubRepositoryUrl, parseReviewPatch } from '../contract'

const execFileAsync = promisify(execFile)
/** The daemon has no console on Windows: without `windowsHide` every git and
 *  gh call would flash a console window. */
const execFileP = ((file: string, args: readonly string[], options: Parameters<typeof execFileAsync>[2]) =>
  execFileAsync(file, args, { windowsHide: true, ...options })) as typeof execFileAsync

const REVIEW_PATCH_MAX_BYTES = 2 * 1024 * 1024
const REVIEW_PATCH_MAX_LINES = 20_000
const REVIEW_CONTENT_MAX_BYTES = 25 * 1024 * 1024

type Methods = VcsCapability['methods']
type Op<K extends keyof Methods> = (params: ParamsOf<Methods[K]>) => Promise<ResultOf<Methods[K]>>

/** A checkout as the porcelain list reports it, before it is shaped for views. */
export interface ListedWorktree {
  path: string
  /** Null for a detached checkout. */
  branch: string | null
  head: string
  isBare: boolean
}

/** The cheap probe the status monitor polls. */
export interface StatusProbe {
  branch: string | null
  dirty: boolean
  branches: string[]
}

export interface GitHost {
  isRepo: Op<'isRepo'>
  findRepos: Op<'findRepos'>
  init: Op<'init'>
  lsFiles: Op<'lsFiles'>
  readStatus: Op<'readStatus'>
  remotes: Op<'remotes'>
  fileWebUrl: Op<'fileWebUrl'>
  compare: Op<'compare'>
  fileDiff: Op<'fileDiff'>
  fileContent: Op<'fileContent'>
  stage: Op<'stage'>
  stageAll: Op<'stageAll'>
  unstage: Op<'unstage'>
  discardFile: Op<'discardFile'>
  commit: Op<'commit'>
  log: Op<'log'>
  push: Op<'push'>
  pull: Op<'pull'>
  fetch: Op<'fetch'>
  branchList: Op<'branchList'>
  branchCreate: Op<'branchCreate'>
  branchDelete: Op<'branchDelete'>
  checkout: Op<'checkout'>
  stash: Op<'stash'>
  stashPop: Op<'stashPop'>
  worktreeList: Op<'worktreeList'>
  worktreeStatus: Op<'worktreeStatus'>
  worktreeReview: Op<'worktreeReview'>
  worktreeMergeTo: Op<'worktreeMergeTo'>
  worktreeUpdateFrom: Op<'worktreeUpdateFrom'>
  createPr: Op<'createPr'>
  prStatus: Op<'prStatus'>
  prList: Op<'prList'>
  // Building blocks of the worktree lifecycle and the status monitor.
  probe(params: { cwd?: string }): Promise<StatusProbe>
  /** True when git ignores every one of `paths` (tracked files never count as ignored). */
  allIgnored(params: { cwd?: string; paths: string[] }): Promise<boolean>
  listWorktrees(params: { cwd?: string }): Promise<ListedWorktree[]>
  addWorktree(params: { cwd?: string; branch: string; targetPath: string; createBranch?: boolean; baseRef?: string }): Promise<{ path: string; branch: string }>
  addWorktreeFromPr(params: { cwd?: string; prNumber: number; targetPath: string }): Promise<{ path: string; branch: string }>
  removeWorktree(params: { cwd?: string; targetPath: string; force?: boolean }): Promise<void>
  pruneWorktrees(params: { cwd?: string }): Promise<{ output: string }>
}

export interface GitHostDeps {
  /** Environment for `git` and `gh` (the login shell's PATH). */
  env: () => NodeJS.ProcessEnv
  /** Resolves `cwd` (the root when absent) inside the workspace path scope;
   *  throws when it is outside. */
  resolveDir: (cwd: string | undefined) => string | Promise<string>
  /** A listed checkout joins the path scope. */
  addCheckout: (checkoutPath: string) => void
  removeCheckout: (checkoutPath: string) => void
  /** Creates `<root>/.cate` with its `.gitignore` (workspace/lifecycle). */
  prepareCateDir?: (cateDir: string) => Promise<void>
}

function gitBuffer(cwd: string, args: string[], env: NodeJS.ProcessEnv, input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', cwd, ...args], { env, encoding: 'buffer', maxBuffer: REVIEW_CONTENT_MAX_BYTES, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

interface ResolvedComparison {
  args: string[]
  rootCommit?: string
  resolvedBase: string | null
  resolvedTarget: string | null
}

function changeStatus(code: string): GitChangeStatus {
  switch (code[0]) {
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'T': return 'type-changed'
    case 'U': return 'unmerged'
    default: return 'modified'
  }
}

function parseNameStatus(raw: string): Array<{ path: string; oldPath?: string; status: GitChangeStatus }> {
  const tokens = raw.split('\0')
  const files: Array<{ path: string; oldPath?: string; status: GitChangeStatus }> = []
  for (let i = 0; i < tokens.length;) {
    const code = tokens[i++]
    if (!code) continue
    const firstPath = tokens[i++] ?? ''
    if (!firstPath) continue
    if (code.startsWith('R') || code.startsWith('C')) {
      const nextPath = tokens[i++] ?? firstPath
      files.push({ path: nextPath, oldPath: firstPath, status: changeStatus(code) })
    } else {
      files.push({ path: firstPath, status: changeStatus(code) })
    }
  }
  return files
}

function parseNumstat(raw: string): Map<string, { additions: number | null; deletions: number | null; oldPath?: string }> {
  const tokens = raw.split('\0')
  const result = new Map<string, { additions: number | null; deletions: number | null; oldPath?: string }>()
  for (let i = 0; i < tokens.length;) {
    const record = tokens[i++]
    if (!record) continue
    const [addsRaw, delsRaw, pathInRecord = ''] = record.split('\t')
    let filePath = pathInRecord
    let oldPath: string | undefined
    if (!filePath) {
      oldPath = tokens[i++] ?? ''
      filePath = tokens[i++] ?? oldPath
    }
    if (!filePath) continue
    result.set(filePath, {
      additions: addsRaw === '-' ? null : Number(addsRaw),
      deletions: delsRaw === '-' ? null : Number(delsRaw),
      ...(oldPath ? { oldPath } : {}),
    })
  }
  return result
}

/** Porcelain `git worktree list` output, CRLF tolerant (Git for Windows can
 *  emit it depending on core.autocrlf). */
export function parseWorktreeList(raw: string): ListedWorktree[] {
  const out: ListedWorktree[] = []
  for (const block of raw.replace(/\r\n/g, '\n').trim().split('\n\n')) {
    let wtPath = ''
    let branch: string | null = null
    let head = ''
    let isBare = false
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length)
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace('refs/heads/', '')
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
      else if (line === 'bare') isBare = true
    }
    if (wtPath) out.push({ path: wtPath, branch, head, isBare })
  }
  return out
}

// Every git op fails with a raw `spawn git ENOENT` on a host without git (the
// one runtime dependency not bundled into the tarball). Replace that with an
// actionable message; a failed probe is not cached, so installing git
// mid-session recovers on the next op.
const GIT_MISSING_MESSAGE =
  'git was not found on this host. Install git (and re-open the workspace if needed) to use source control.'

function looksLikeMissingGit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('spawn git ENOENT') || /'git' is not recognized/i.test(msg)
}

function guardGitMissing<T extends object>(host: T, env: () => NodeJS.ProcessEnv): T {
  let probe: Promise<boolean> | null = null
  const gitAvailable = (): Promise<boolean> =>
    (probe ??= execFileP('git', ['--version'], { env: env() }).then(
      () => true,
      () => {
        probe = null
        return false
      },
    ))
  const guarded = {} as Record<string, unknown>
  for (const [key, method] of Object.entries(host)) {
    guarded[key] = async (...args: unknown[]) => {
      try {
        return await (method as (...a: unknown[]) => Promise<unknown>)(...args)
      } catch (err) {
        if (looksLikeMissingGit(err) && !(await gitAvailable())) throw new Error(GIT_MISSING_MESSAGE)
        throw err
      }
    }
  }
  return guarded as T
}

// Heavy build/vendor output we never descend into while scanning for repos.
const SCAN_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'vendor',
  '.git', '.cache', '.next', '.turbo', '.venv', 'venv', '__pycache__',
])

// The env is the user's own, never caller input, so it may carry the editor,
// pager, askpass, ssh and config-path variables simple-git refuses in an
// explicit env (a user's EDITOR would otherwise fail every call).
const USER_ENV_UNSAFE = {
  allowUnsafeEditor: true, allowUnsafePager: true, allowUnsafeAskPass: true,
  allowUnsafeSshCommand: true, allowUnsafeConfigPaths: true, allowUnsafeConfigEnvCount: true,
  allowUnsafeDiffExternal: true, allowUnsafeGitProxy: true, allowUnsafeTemplateDir: true,
}

export function createGitHost(deps: GitHostDeps): GitHost {
  // No optional locks: a background `git status` otherwise takes index.lock
  // for a moment, and a concurrent `git add` or commit then fails on it.
  const env = () => ({ ...deps.env(), GIT_OPTIONAL_LOCKS: '0' })
  const gitAt = (baseDir: string) => simpleGit({ baseDir, unsafe: USER_ENV_UNSAFE }).env(env())
  const dir = async (cwd: string | undefined) => deps.resolveDir(cwd)

  function validateFilePath(cwd: string, filePath: string): string {
    const resolvedCwd = path.resolve(cwd)
    const resolved = path.resolve(cwd, filePath)
    if (resolved !== resolvedCwd && !resolved.startsWith(resolvedCwd + path.sep)) {
      throw new Error('filePath escapes workspace')
    }
    return path.relative(cwd, resolved)
  }

  async function repositoryContext(cwd: string | undefined) {
    const validCwd = await dir(cwd)
    let top: string
    try {
      top = await gitAt(validCwd).revparse(['--show-toplevel'])
    } catch (err) {
      if (!looksLikeMissingGit(err) && !(await insideRepo(validCwd))) throw new NotARepositoryError(validCwd)
      throw err
    }
    const repoRoot = path.resolve(top.trim())
    return { repoRoot, git: gitAt(repoRoot) }
  }

  /** Whether `dirPath` or a folder above it has a `.git`. */
  async function insideRepo(dirPath: string): Promise<boolean> {
    for (let current = dirPath; ; current = path.dirname(current)) {
      if (await isGitRepo(current)) return true
      if (path.dirname(current) === current) return false
    }
  }

  async function resolveCommit(git: SimpleGit, ref: string): Promise<string> {
    if (!ref.trim()) throw new Error('A Git ref is required')
    try {
      return (await git.revparse(['--verify', `${ref}^{commit}`])).trim()
    } catch {
      throw new Error(`Invalid Git ref "${ref}"`)
    }
  }

  async function resolveComparison(repoRoot: string, git: SimpleGit, spec: GitComparisonSpec): Promise<ResolvedComparison> {
    if (spec.kind === 'unstaged') {
      return { args: [], resolvedBase: 'INDEX', resolvedTarget: 'WORKTREE' }
    }
    if (spec.kind === 'uncommitted' || spec.kind === 'staged') {
      let head: string
      let resolvedHead: string | null
      try {
        head = await resolveCommit(git, 'HEAD')
        resolvedHead = head
      } catch {
        // The canonical empty tree (SHA-1 or SHA-256), so a repository with
        // no commits can review its first staged files.
        head = (await gitBuffer(repoRoot, ['hash-object', '-t', 'tree', '--stdin'], env(), Buffer.alloc(0))).toString().trim()
        resolvedHead = null
      }
      return spec.kind === 'uncommitted'
        ? { args: [head], resolvedBase: resolvedHead, resolvedTarget: 'WORKTREE' }
        : { args: ['--cached', head], resolvedBase: resolvedHead, resolvedTarget: 'INDEX' }
    }
    if (spec.kind === 'commit') {
      const commit = await resolveCommit(git, spec.commit)
      try {
        const parent = await resolveCommit(git, `${commit}^`)
        return { args: [parent, commit], resolvedBase: parent, resolvedTarget: commit }
      } catch {
        return { args: [], rootCommit: commit, resolvedBase: null, resolvedTarget: commit }
      }
    }
    const base = await resolveCommit(git, spec.base)
    const target = await resolveCommit(git, spec.target)
    const mergeBase = (await git.raw(['merge-base', base, target])).trim()
    if (!mergeBase) throw new Error(`No merge base exists between ${spec.base} and ${spec.target}`)
    return { args: [mergeBase, target], resolvedBase: mergeBase, resolvedTarget: target }
  }

  async function comparisonRaw(
    git: SimpleGit,
    resolved: ResolvedComparison,
    spec: GitComparisonSpec,
    options: string[],
    filePath?: string,
  ): Promise<string> {
    const common = ['--no-ext-diff', '--no-color', '--find-renames', ...(spec.ignoreWhitespace ? ['--ignore-all-space'] : [])]
    if (resolved.rootCommit) {
      return git.raw(['show', '--format=', ...common, ...options, resolved.rootCommit, ...(filePath ? ['--', filePath] : [])])
    }
    return git.raw(['diff', ...common, ...options, ...resolved.args, ...(filePath ? ['--', filePath] : [])])
  }

  async function untrackedSummary(validCwd: string, filePath: string): Promise<Pick<GitChangedFile, 'additions' | 'deletions' | 'binary'>> {
    try {
      const absolutePath = path.join(validCwd, filePath)
      const stat = await fsp.stat(absolutePath)
      const handle = await fsp.open(absolutePath, 'r')
      const probe = Buffer.alloc(Math.min(stat.size, 8192))
      try {
        await handle.read(probe, 0, probe.length, 0)
      } finally {
        await handle.close()
      }
      if (probe.includes(0)) return { additions: null, deletions: null, binary: true }
      if (stat.size > REVIEW_PATCH_MAX_BYTES) return { additions: null, deletions: null, binary: false }
      const text = (await fsp.readFile(absolutePath)).toString('utf8')
      const additions = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0
      return { additions, deletions: 0, binary: false }
    } catch {
      return { additions: 0, deletions: 0, binary: false }
    }
  }

  async function isGitRepo(dirPath: string): Promise<boolean> {
    try {
      await fsp.access(path.join(dirPath, '.git'))
      return true
    } catch {
      return false
    }
  }

  async function findReposFrom(current: string, depth: number, maxDepth: number, out: string[]): Promise<void> {
    if (await isGitRepo(current)) {
      out.push(current)
      return
    }
    if (depth >= maxDepth) return
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || SCAN_SKIP_DIRS.has(entry.name)) continue
      await findReposFrom(path.join(current, entry.name), depth + 1, maxDepth, out)
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

  async function availablePrBranch(git: SimpleGit, prNumber: number): Promise<string> {
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

  /** `<root>/.cate/worktrees` must exist; `<root>/.cate` gets its gitignore. */
  async function ensureContainingDir(targetPath: string): Promise<void> {
    const containingDir = path.dirname(targetPath)
    await fsp.mkdir(containingDir, { recursive: true })
    await deps.prepareCateDir?.(path.dirname(containingDir))
  }

  async function compareUrlFor(git: SimpleGit, branch: string): Promise<string | null> {
    try {
      const remote = (await git.raw(['remote', 'get-url', 'origin'])).trim()
      const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/)
      if (!m) return null
      return `https://github.com/${m[1]}/compare/${encodeURIComponent(branch)}?expand=1`
    } catch {
      return null
    }
  }

  async function listWorktrees({ cwd }: { cwd?: string }): Promise<ListedWorktree[]> {
    const validCwd = await dir(cwd)
    const listed = parseWorktreeList(await gitAt(validCwd).raw(['worktree', 'list', '--porcelain']))
    for (const wt of listed) if (!wt.isBare) deps.addCheckout(wt.path)
    return listed
  }

  const host: GitHost = {
    async isRepo({ cwd }) {
      return isGitRepo(await dir(cwd))
    },
    async findRepos({ dir: from, maxDepth }) {
      const out: string[] = []
      await findReposFrom(await dir(from), 0, Math.max(1, maxDepth ?? 1), out)
      return out
    },
    async init({ cwd }) {
      await gitAt(await dir(cwd)).init()
    },
    async lsFiles({ cwd }) {
      try {
        const result = await gitAt(await dir(cwd)).raw(['ls-files', '--cached', '--others', '--exclude-standard'])
        return result.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
      } catch {
        return []
      }
    },
    async remotes({ cwd }) {
      const remotes = await gitAt(await dir(cwd)).getRemotes(true)
      return remotes.map((remote) => ({ name: remote.name, fetchUrl: remote.refs.fetch, pushUrl: remote.refs.push }))
    },
    async fileWebUrl({ path: file }) {
      const git = gitAt(await dir(path.dirname(file)))
      let prefix: string, remote: string, branch: string
      try {
        ;[prefix, remote, branch] = await Promise.all([
          git.raw(['rev-parse', '--show-prefix']),
          git.raw(['remote', 'get-url', 'origin']),
          git.raw(['branch', '--show-current']),
        ])
      } catch {
        return null
      }
      const repository = githubRepositoryUrl(remote)
      if (!repository) return null
      const relative = `${prefix.trim()}${path.basename(file)}`.split('/').map(encodeURIComponent).join('/')
      return { url: `${repository}/blob/${encodeURIComponent(branch.trim() || 'HEAD')}/${relative}` }
    },
    async readStatus({ cwd }) {
      const status = await gitAt(await dir(cwd)).status()
      return {
        files: status.files.map((f) => ({ path: f.path, index: f.index, working_dir: f.working_dir })),
        current: status.detached ? null : status.current,
        tracking: status.tracking,
        ahead: status.ahead,
        behind: status.behind,
      }
    },
    async compare({ cwd, spec }) {
      const { repoRoot, git } = await repositoryContext(cwd)
      const resolved = await resolveComparison(repoRoot, git, spec)
      const [nameStatusRaw, numstatRaw, status] = await Promise.all([
        comparisonRaw(git, resolved, spec, ['--name-status', '-z']),
        comparisonRaw(git, resolved, spec, ['--numstat', '-z']),
        git.status(['--untracked-files=all']),
      ])
      const stats = parseNumstat(numstatRaw)
      const statusByPath = new Map(status.files.map((file) => [file.path, file]))
      const namedFiles = parseNameStatus(nameStatusRaw)
      // With -w, --name-status still lists whitespace-only paths while
      // --numstat omits them, so numstat decides visibility there.
      const visibleFiles = spec.ignoreWhitespace ? namedFiles.filter((file) => stats.has(file.path)) : namedFiles
      const files: GitChangedFile[] = visibleFiles.map((file) => {
        const counts = stats.get(file.path)
        const current = statusByPath.get(file.path)
        return {
          ...file,
          oldPath: file.oldPath ?? counts?.oldPath,
          additions: counts?.additions ?? 0,
          deletions: counts?.deletions ?? 0,
          binary: counts?.additions == null || counts?.deletions == null,
          staged: spec.kind === 'staged' || spec.kind === 'uncommitted'
            ? !!current && current.index !== ' ' && current.index !== '?'
            : false,
          working: spec.kind === 'unstaged' || spec.kind === 'uncommitted'
            ? !!current && current.working_dir !== ' '
            : false,
        }
      })

      if (spec.kind === 'uncommitted' || spec.kind === 'unstaged') {
        const known = new Set(files.map((file) => file.path))
        for (const current of status.files) {
          if (current.working_dir !== '?' || known.has(current.path)) continue
          const summary = await untrackedSummary(repoRoot, current.path)
          files.push({ path: current.path, status: 'added', ...summary, staged: false, working: true, untracked: true })
        }
      }

      return {
        spec,
        resolvedBase: resolved.resolvedBase,
        resolvedTarget: resolved.resolvedTarget,
        currentBranch: status.detached ? null : status.current,
        files,
        additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
        deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      }
    },
    async fileDiff({ cwd, spec, path: filePath, contextLines: requestedContext, allowLarge }) {
      const { repoRoot, git } = await repositoryContext(cwd)
      const relativePath = validateFilePath(repoRoot, filePath)
      const resolved = await resolveComparison(repoRoot, git, spec)
      const status = await git.status(['--untracked-files=all'])
      const untracked = (spec.kind === 'uncommitted' || spec.kind === 'unstaged')
        && status.files.some((file) => file.path === relativePath && file.working_dir === '?')
      if (untracked) {
        const content = await fsp.readFile(path.join(repoRoot, relativePath))
        const binary = content.includes(0)
        const byteLength = content.byteLength
        const lines = binary ? [] : content.toString('utf8').split('\n')
        const tooLarge = !allowLarge && (byteLength > REVIEW_PATCH_MAX_BYTES || lines.length > REVIEW_PATCH_MAX_LINES)
        if (binary || tooLarge) return { path: relativePath, binary, tooLarge, byteLength, hunks: [] }
        const displayLines = lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
        const patch = [
          `diff --git a/${relativePath} b/${relativePath}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${relativePath}`,
          `@@ -0,0 +1,${displayLines.length} @@`,
          ...displayLines.map((line) => `+${line}`),
          '',
        ].join('\n')
        return {
          path: relativePath,
          binary: false,
          tooLarge: false,
          byteLength,
          patch,
          hunks: [{
            header: `@@ -0,0 +1,${displayLines.length} @@`,
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: displayLines.length,
            lines: displayLines.map((text, index) => ({ kind: 'add' as const, text, oldLine: null, newLine: index + 1 })),
          }],
        }
      }

      const contextLines = Math.max(0, Math.min(requestedContext ?? 3, 999_999))
      const raw = await comparisonRaw(git, resolved, spec, ['--binary', `--unified=${contextLines}`], relativePath)
      const byteLength = Buffer.byteLength(raw)
      const lineCount = raw ? raw.split('\n').length : 0
      const binary = raw.includes('GIT binary patch') || raw.includes('Binary files ')
      const tooLarge = !allowLarge && (byteLength > REVIEW_PATCH_MAX_BYTES || lineCount > REVIEW_PATCH_MAX_LINES)
      return {
        path: relativePath,
        binary,
        tooLarge,
        byteLength,
        patch: tooLarge ? undefined : raw,
        hunks: binary || tooLarge ? [] : parseReviewPatch(raw),
      }
    },
    async fileContent({ cwd, spec, path: filePath, side }) {
      const { repoRoot, git } = await repositoryContext(cwd)
      const relativePath = validateFilePath(repoRoot, filePath)
      const resolved = await resolveComparison(repoRoot, git, spec)
      const worktreeSide = side === 'new' && (spec.kind === 'uncommitted' || spec.kind === 'unstaged')
      try {
        let content: Buffer
        if (worktreeSide) {
          content = await fsp.readFile(path.join(repoRoot, relativePath))
        } else {
          let object: string | null = null
          if (spec.kind === 'unstaged') object = `:${relativePath}`
          else if (spec.kind === 'staged') object = side === 'old' ? `${resolved.resolvedBase}:${relativePath}` : `:${relativePath}`
          else {
            const ref = side === 'old' ? resolved.resolvedBase : resolved.resolvedTarget
            if (ref && ref !== 'WORKTREE' && ref !== 'INDEX') object = `${ref}:${relativePath}`
          }
          if (!object) throw new Error('File side does not exist')
          content = await gitBuffer(repoRoot, ['show', object], env())
        }
        return { exists: true, size: content.byteLength, base64: content.toString('base64') }
      } catch {
        return { exists: false, size: 0 }
      }
    },
    async stage({ cwd, path: filePath }) {
      const { repoRoot, git } = await repositoryContext(cwd)
      await git.add(validateFilePath(repoRoot, filePath))
    },
    async stageAll({ cwd }) {
      await gitAt(await dir(cwd)).add(['-A'])
    },
    async unstage({ cwd, path: filePath }) {
      const { repoRoot, git } = await repositoryContext(cwd)
      await git.reset([validateFilePath(repoRoot, filePath)])
    },
    async discardFile({ cwd, path: filePath }) {
      const { repoRoot, git } = await repositoryContext(cwd)
      await git.checkout(['--', validateFilePath(repoRoot, filePath)])
    },
    async commit({ cwd, message }) {
      await gitAt(await dir(cwd)).commit(message)
    },
    async log({ cwd, maxCount }) {
      const logResult = await gitAt(await dir(cwd)).log({ maxCount: maxCount || 50 })
      return logResult.all.map((e) => ({
        hash: e.hash, message: e.message, author_name: e.author_name, author_email: e.author_email, date: e.date,
      }))
    },
    async push({ cwd, remote, branch }) {
      await gitAt(await dir(cwd)).push(remote || 'origin', branch)
    },
    async pull({ cwd, remote, branch }) {
      const result = await gitAt(await dir(cwd)).pull(remote || 'origin', branch)
      return {
        summary: { changes: result.summary.changes, insertions: result.summary.insertions, deletions: result.summary.deletions },
      }
    },
    async fetch({ cwd, remote }) {
      await gitAt(await dir(cwd)).fetch(remote || 'origin', ['--prune'])
    },
    async branchList({ cwd }) {
      const result = await gitAt(await dir(cwd)).branch(['-a', '--sort=-committerdate'])
      return {
        current: result.current,
        branches: Object.entries(result.branches).map(([name, info]) => ({
          name, current: info.current, commit: info.commit, label: info.label, isRemote: name.startsWith('remotes/'),
        })),
      }
    },
    async branchCreate({ cwd, name, startPoint }) {
      const git = gitAt(await dir(cwd))
      if (startPoint) await git.checkoutBranch(name, startPoint)
      else await git.checkoutLocalBranch(name)
    },
    async branchDelete({ cwd, name, force }) {
      await gitAt(await dir(cwd)).branch([force ? '-D' : '-d', name])
    },
    async checkout({ cwd, branch }) {
      await gitAt(await dir(cwd)).checkout(branch)
    },
    async stash({ cwd, message }) {
      const git = gitAt(await dir(cwd))
      if (message) await git.stash(['push', '-m', message])
      else await git.stash()
    },
    async stashPop({ cwd }) {
      await gitAt(await dir(cwd)).stash(['pop'])
    },
    async worktreeList({ cwd }) {
      try {
        const validCwd = await dir(cwd)
        const listed = await listWorktrees({ cwd: validCwd })
        return listed.map((wt): GitWorktree => ({
          path: wt.path,
          branch: wt.branch || wt.head.substring(0, 8) || '(unknown)',
          isBare: wt.isBare,
          isCurrent: path.resolve(wt.path) === path.resolve(validCwd),
        }))
      } catch {
        return []
      }
    },
    async worktreeStatus({ path: worktreePath }) {
      const validPath = await dir(worktreePath)
      try {
        const stat = await fsp.stat(validPath)
        if (!stat.isDirectory()) return null
      } catch {
        return null
      }
      const git = gitAt(validPath)
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
    async worktreeReview({ path: worktreePath, baseBranch }) {
      const git = gitAt(await dir(worktreePath))
      const status = await git.status()
      const branch = status.current === 'HEAD' ? '' : status.current ?? ''
      const dirty = status.files.length > 0
      const workingFiles = status.files.map((file) => file.path)
      let mergeBase: string
      try {
        mergeBase = (await git.raw(['merge-base', baseBranch, 'HEAD'])).trim()
      } catch {
        return {
          branch, baseBranch, dirty, canApply: false, commits: [], files: [], workingFiles,
          message: `Couldn’t compare this worktree with ${baseBranch}.`,
        }
      }
      const [commitText, fileText] = await Promise.all([
        git.raw(['log', '--format=%H%x09%s', '-n', '100', `${mergeBase}..HEAD`]),
        git.raw(['diff', '--name-status', `${mergeBase}...HEAD`]),
      ])
      const commits = commitText.trim().split('\n').filter(Boolean).map((line) => {
        const [hash, ...message] = line.split('\t')
        return { hash, message: message.join('\t') }
      })
      const files = fileText.trim().split('\n').filter(Boolean).map((line) => {
        const [statusCode, ...paths] = line.split('\t')
        return { status: statusCode, path: paths.at(-1) ?? '' }
      })
      return {
        branch,
        baseBranch,
        dirty,
        canApply: Boolean(branch) && !dirty && commits.length > 0,
        commits,
        files,
        workingFiles,
        ...(!branch
          ? { message: 'Check out a named branch in this worktree before applying it.' }
          : dirty
            ? { message: 'Commit or discard the worker’s uncommitted changes before applying it.' }
            : commits.length === 0
              ? { message: `No unapplied commits differ from ${baseBranch}.` }
              : {}),
      }
    },
    async worktreeMergeTo({ cwd, from, to }) {
      const git = gitAt(await dir(cwd))
      try {
        if ((await git.status()).files.length > 0) {
          return { ok: false, conflict: false, message: `Commit or stash changes in ${to} before merging into it.` }
        }
        await git.checkout(to)
        const result = await git.merge([from, '--no-edit'])
        return { ok: true, result }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        const mergeInProgress = await git.raw(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true, () => false)
        if (/CONFLICT|conflict/.test(msg) || mergeInProgress) {
          const aborted = await git.raw(['merge', '--abort']).then(() => true, () => false)
          return {
            ok: false,
            conflict: true,
            message: aborted
              ? 'The branches have conflicting changes. The merge was aborted.'
              : `The branches have conflicting changes. Open a terminal in ${to} to resolve or abort the merge.`,
          }
        }
        return { ok: false, conflict: false, message: `Couldn’t merge ${from} into ${to}. Make sure both branches still exist.` }
      }
    },
    async worktreeUpdateFrom({ path: worktreePath, from }) {
      const git = gitAt(await dir(worktreePath))
      try {
        if ((await git.status()).files.length > 0) {
          return { ok: false, conflict: false, message: `Commit or stash changes before updating from ${from}.` }
        }
        await git.fetch().catch(() => {})
        const result = await git.merge([from, '--no-edit'])
        return { ok: true, result }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        const conflict = /CONFLICT|conflict/.test(msg)
        return {
          ok: false,
          conflict,
          message: conflict ? 'The branches have conflicting changes.' : `Couldn’t update from ${from}. Make sure the branch still exists.`,
        }
      }
    },
    async createPr({ path: worktreePath, branch }) {
      const cwd = await dir(worktreePath)
      const git = gitAt(cwd)
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
          } catch { /* fall through to the compare URL */ }
        }
      }
      const url = await compareUrlFor(git, branch)
      if (url) return { ok: true, created: false, url, fallback: true }
      return { ok: false, message: 'Pushed, but could not determine the GitHub URL (no origin remote?).' }
    },
    async prStatus({ path: worktreePath, branch }) {
      try {
        const cwd = await dir(worktreePath)
        if (!(await ghAvailable(cwd))) return null
        const { stdout } = await execFileP('gh', ['pr', 'view', branch, '--json', 'number,state,url,isDraft'], { cwd, timeout: 10000, env: env() })
        const data = JSON.parse(stdout) as { number: number; state: string; url: string; isDraft: boolean }
        return { number: data.number, state: data.state, url: data.url, isDraft: data.isDraft }
      } catch {
        return null
      }
    },
    async prList({ cwd: repoCwd }) {
      try {
        const cwd = await dir(repoCwd)
        if (!(await ghAvailable(cwd))) return []
        const { stdout } = await execFileP('gh', ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,headRefName,author,isCrossRepository'], { cwd, timeout: 15000, env: env() })
        const arr = JSON.parse(stdout) as Array<{ number: number; title: string; headRefName: string; author?: { login?: string }; isCrossRepository?: boolean }>
        return arr.map((p) => ({ number: p.number, title: p.title, headRefName: p.headRefName, author: p.author?.login ?? '', isFork: !!p.isCrossRepository }))
      } catch {
        return []
      }
    },

    async probe({ cwd }) {
      const validCwd = await dir(cwd)
      const run = (args: string[]) =>
        execFileP('git', ['-C', validCwd, ...args], { timeout: 3000, env: env() }).then((r) => r.stdout)
      const [branchOut, statusOut, branchesOut] = await Promise.all([
        run(['branch', '--show-current']),
        run(['status', '--porcelain', '-uno']),
        run(['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      ])
      const branch = branchOut.trim()
      return {
        branch: branch || null,
        dirty: statusOut.trim().length > 0,
        branches: branchesOut.split('\n').map((s) => s.trim()).filter(Boolean).sort(),
      }
    },
    async allIgnored({ cwd, paths }) {
      if (paths.length === 0) return true
      let out: Buffer
      try {
        out = await gitBuffer(await dir(cwd), ['check-ignore', '--stdin', '-z'], env(), Buffer.from(paths.join('\0') + '\0'))
      } catch {
        // Exit 1: none ignored. Anything else (not a repo, git failed): treat as a change.
        return false
      }
      return new Set(out.toString('utf-8').split('\0').filter(Boolean)).size >= new Set(paths).size
    },
    listWorktrees,
    async addWorktree({ cwd, branch, targetPath, createBranch, baseRef }) {
      const git = gitAt(await dir(cwd))
      await ensureContainingDir(targetPath)
      const args = ['worktree', 'add']
      if (createBranch) args.push('-b', branch, targetPath, baseRef ?? 'HEAD')
      else args.push(targetPath, branch)
      await git.raw(args)
      deps.addCheckout(targetPath)
      return { path: targetPath, branch }
    },
    async addWorktreeFromPr({ cwd, prNumber, targetPath }) {
      const validRepo = await dir(cwd)
      const git = gitAt(validRepo)
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
      deps.addCheckout(targetPath)
      try {
        // Never let gh reuse the contributor's local branch: it may have
        // diverged, be checked out elsewhere, or hold unpublished work.
        await execFileP('gh', ['pr', 'checkout', String(prNumber), '--branch', branch], { cwd: targetPath, timeout: 120000, env: env() })
      } catch (error) {
        await git.raw(['worktree', 'remove', '--force', targetPath]).catch(() => {})
        await git.branch(['-D', branch]).catch(() => {})
        await fsp.rm(targetPath, { recursive: true, force: true }).catch(() => {})
        deps.removeCheckout(targetPath)
        throw prCheckoutError(prNumber, error)
      }
      return { path: targetPath, branch }
    },
    async removeWorktree({ cwd, targetPath, force }) {
      const git = gitAt(await dir(cwd))
      const args = ['worktree', 'remove']
      if (force) args.push('--force')
      args.push(targetPath)
      await git.raw(args)
      await fsp.rm(targetPath, { recursive: true, force: true }).catch(() => {})
      deps.removeCheckout(targetPath)
    },
    async pruneWorktrees({ cwd }) {
      const output = await gitAt(await dir(cwd)).raw(['worktree', 'prune', '-v'])
      return { output }
    },
  }
  return guardGitMissing(host, env)
}
