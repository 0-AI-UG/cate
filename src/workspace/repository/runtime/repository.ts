// The repository runtime: git and `gh` behind trust, status monitors, and the
// worktree lifecycle, which writes `WorktreeMeta` status through the document
// so every client sees a create or remove in progress. Trust is enforced
// here, not at the capability: the `git` and `github` it hands out refuse
// every call while the workspace is untrusted, and the monitors run no git
// until it is trusted.

import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '@kernel/log/contract'
import { RpcError, type ParamsOf } from '@kernel/rpc/contract'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import { KeyedLock } from '@kernel/state/contract'
import type { DocBatch, DocChange, WorkspaceDocument, WorktreeMeta } from '@workspace/document/contract'
import {
  checkoutPathKey,
  EMPTY_REPO_STATUS,
  pickWorktreeColor,
  samePath,
  toBranchName,
  worktreeRemovalChanges,
  worktreeSlug,
  WORKTREES_DIR,
  type RepoStatus,
  type VcsCapability,
  type WorktreePruneResult,
  type WorktreeRemoveResult,
  type PullRequestContext,
} from '../contract'
import { createGitHost, type GitHost } from './git'
import { createGithubHost, type GithubHost } from './github'
import { createStatusMonitors, type StatusMonitors } from './statusMonitor'

export interface RepositoryTrust {
  isTrusted(): boolean
  /** Throws `RpcError('untrusted')`. */
  requireTrusted(): void
}

/** The part of the files path scope this module uses. */
export interface RepositoryPathScope {
  /** An absolute directory inside the scope (root, checkouts, grants), or a
   *  throw. */
  resolveDir(dir: string): string | Promise<string>
  addCheckout(checkoutPath: string): void
  removeCheckout(checkoutPath: string): void
}

/** The document runtime as the lifecycle needs it. It stamps its own opId on
 *  what it applies. */
export interface DocumentWriter {
  apply(op: DocChange | DocBatch): Promise<void>
  get(): WorkspaceDocument
}

export interface RepositoryRuntimeDeps {
  /** Canonical workspace root; checkouts go under `<root>/.cate/worktrees`. */
  root: string
  env: () => NodeJS.ProcessEnv
  trust: RepositoryTrust
  paths: RepositoryPathScope
  document: DocumentWriter
  settings: { get(key: 'closeWorktreePanelsOnDelete'): boolean }
  log?: Logger
  /** The files watcher, so a checkout's status follows file changes. */
  watch?: (dir: string, onChange: (changedPath: string) => void) => () => void
  /** Creates `<root>/.cate` with its `.gitignore` (workspace/lifecycle). */
  prepareCateDir?: (cateDir: string) => Promise<void>
  /** After a checkout is ready (skills sync). Failures are logged only. */
  onWorktreeCreated?: (meta: WorktreeMeta) => void | Promise<void>
  newId?: () => string
}

/** git calls that change the repository: they run in the write queue and
 *  wake the status monitors. */
const GIT_WRITES = [
  'init', 'stage', 'stageAll', 'unstage', 'discardFile', 'commit', 'push', 'pull', 'fetch', 'branchCreate',
  'branchDelete', 'checkout', 'stash', 'stashPop', 'worktreeMergeTo', 'worktreeUpdateFrom', 'createPr',
] as const satisfies readonly (keyof GitHost)[]
const GIT_READS = [
  'isRepo', 'findRepos', 'lsFiles', 'readStatus', 'remotes', 'fileWebUrl', 'compare', 'fileDiff', 'fileContent',
  'log', 'branchList', 'worktreeList', 'worktreeStatus', 'worktreeReview', 'prStatus', 'prList',
] as const satisfies readonly (keyof GitHost)[]

/** The git the rest of the runtime gets: every call needs trust. */
export type RepositoryGit = Pick<GitHost, (typeof GIT_WRITES)[number] | (typeof GIT_READS)[number]>
/** The `gh` the rest of the runtime gets: every call needs trust. */
export type RepositoryGithub = Pick<GithubHost, 'connection' | 'pullRequests' | 'loginState' | 'startLogin' | 'cancelLogin'>
  & { pullRequestContext(repository: string, number: number): Promise<PullRequestContext | null> }

type CreateParams = ParamsOf<VcsCapability['methods']['worktreeCreate']>
type RemoveParams = ParamsOf<VcsCapability['methods']['worktreeRemove']>

export interface RepositoryRuntime {
  readonly root: string
  readonly git: RepositoryGit
  readonly github: RepositoryGithub
  /** Status monitors; they read nothing while the workspace is untrusted. */
  readonly monitors: Pick<StatusMonitors, 'subscribe' | 'kick'>
  /** Trust was granted or revoked: monitors resume, or stop reading. */
  trustChanged(): void
  resolveDir(cwd?: string): Promise<string>
  createWorktree(params: CreateParams): Promise<WorktreeMeta>
  removeWorktree(params: RemoveParams): Promise<WorktreeRemoveResult>
  pruneWorktrees(): Promise<WorktreePruneResult>
  /** Adds metadata for checkouts git lists but the document lacks (the main
   *  checkout, ones made with the git CLI). Never removes. */
  reconcileWorktrees(): Promise<void>
  snapshot(cwd: string): Promise<RepoStatus>
  dispose(): void
}

export function createRepositoryRuntime(deps: RepositoryRuntimeDeps): RepositoryRuntime {
  const { root, trust, document } = deps
  const newId = deps.newId ?? (() => `wt-${randomUUID()}`)
  const lock = new KeyedLock()
  const REPO = 'repository'
  const write = <T>(fn: () => Promise<T>) => lock.run(REPO, fn)
  const inFlight = new Map<string, Promise<unknown>>()

  const raw = createGitHost({
    env: deps.env,
    resolveDir: (cwd) => deps.paths.resolveDir(cwd ?? root),
    addCheckout: (p) => deps.paths.addCheckout(p),
    removeCheckout: (p) => deps.paths.removeCheckout(p),
    prepareCateDir: deps.prepareCateDir,
  })
  const rawGithub = createGithubHost({ env: deps.env })

  const gated = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    trust.requireTrusted()
    return fn(...args)
  }
  const git = Object.fromEntries([
    ...GIT_READS.map((name) => [name, gated(raw[name] as (p: unknown) => Promise<unknown>)]),
    ...GIT_WRITES.map((name) => [name, gated((p: unknown) =>
      write(() => (raw[name] as (p: unknown) => Promise<unknown>)(p)).finally(() => monitors.kick()))]),
  ]) as unknown as RepositoryGit
  const github: RepositoryGithub = {
    connection: gated(() => rawGithub.connection()),
    pullRequests: gated((refresh?: boolean) => rawGithub.pullRequests(refresh)),
    loginState: gated((owner: number) => rawGithub.loginState(owner)),
    startLogin: gated((owner: number) => rawGithub.startLogin(owner)),
    cancelLogin: gated((owner: number) => rawGithub.cancelLogin(owner)),
    pullRequestContext: gated(async (repository: string, number: number) => {
      if (!(await raw.isRepo({}))) return null
      return rawGithub.pullRequestContext(root, repository, number)
    }),
  }

  async function snapshot(cwd: string): Promise<RepoStatus> {
    if (!(await raw.isRepo({ cwd }))) return EMPTY_REPO_STATUS
    const [status, probe, worktrees] = await Promise.all([
      raw.readStatus({ cwd }),
      raw.probe({ cwd }),
      raw.worktreeList({ cwd }),
    ])
    return {
      isRepo: true,
      branch: status.current,
      dirty: probe.dirty,
      tracking: status.tracking,
      ahead: status.ahead,
      behind: status.behind,
      files: status.files,
      branches: probe.branches,
      worktrees,
    }
  }

  let lastRootWorktrees: string | null = null
  const monitors = createStatusMonitors({
    probe: (cwd) => raw.probe({ cwd }),
    snapshot,
    watch: deps.watch,
    allIgnored: (cwd, paths) => raw.allIgnored({ cwd, paths }),
    active: () => trust.isTrusted(),
    log: deps.log,
    onSnapshot: (cwd, status) => {
      if (!samePath(cwd, root)) return
      const key = JSON.stringify(status.worktrees.map((w) => checkoutPathKey(w.path)).sort())
      if (key === lastRootWorktrees) return
      lastRootWorktrees = key
      reconcileWorktrees().catch((err) => deps.log?.warn('worktree reconcile failed: %s', errorText(err)))
    },
  })

  /** A second identical call joins the running one. */
  function joined<T>(key: string, run: () => Promise<T>): Promise<T> {
    const running = inFlight.get(key)
    if (running) return running as Promise<T>
    const p = run().finally(() => inFlight.delete(key))
    inFlight.set(key, p)
    return p
  }

  async function applyAll(changes: DocChange[]): Promise<void> {
    if (changes.length === 0) return
    await document.apply(changes.length === 1 ? changes[0] : { kind: 'batch', changes })
  }

  const worktrees = () => Object.values(document.get().worktrees)

  function createWorktree(params: CreateParams): Promise<WorktreeMeta> {
    trust.requireTrusted()
    const typed = params.branch ?? ''
    const branch = toBranchName(typed)
    if (!branch) return Promise.reject(new RpcError('rejected', 'Please enter a name'))
    const fromPr = params.fromPr
    if (fromPr !== undefined && (!Number.isSafeInteger(fromPr) || fromPr < 1)) {
      return Promise.reject(new RpcError('rejected', 'Invalid pull request number'))
    }
    const slug = worktreeSlug(fromPr !== undefined ? `pr-${fromPr}-${branch}` : branch)
    const targetPath = path.join(root, ...WORKTREES_DIR, slug)
    const label = params.label?.trim()
      || (fromPr !== undefined ? `#${fromPr} ${typed.trim()}` : typed.trim() !== branch ? typed.trim() : undefined)

    const create = async (): Promise<WorktreeMeta> => {
      if (worktrees().some((w) => samePath(w.path, targetPath))) {
        throw new RpcError('rejected', `A worktree already exists at ${targetPath}`)
      }
      const meta: WorktreeMeta = {
        id: newId(),
        path: targetPath,
        color: pickWorktreeColor(worktrees()),
        ...(label ? { label } : {}),
        ...(fromPr !== undefined ? { prNumber: fromPr } : {}),
        status: 'creating',
      }
      await document.apply({ kind: 'setWorktree', worktree: meta })
      try {
        if (fromPr !== undefined) await raw.addWorktreeFromPr({ prNumber: fromPr, targetPath })
        else await raw.addWorktree({ branch, targetPath, createBranch: true, baseRef: params.base })
      } catch (err) {
        await document.apply({ kind: 'removeWorktree', id: meta.id }).catch(() => {})
        throw err
      }
      const ready: WorktreeMeta = { ...meta, status: 'ready' }
      await document.apply({ kind: 'setWorktree', worktree: ready })
      return ready
    }

    return joined(`create:${checkoutPathKey(targetPath)}`, async () => {
      const created = await write(create)
      monitors.kick()
      try {
        await deps.onWorktreeCreated?.(created)
      } catch (err) {
        deps.log?.warn('after-create hook failed for %s: %s', created.path, errorText(err))
      }
      return created
    })
  }

  function removeWorktree(params: RemoveParams): Promise<WorktreeRemoveResult> {
    trust.requireTrusted()
    return joined(`remove:${params.worktreeId}`, () => write(async () => {
      const meta = document.get().worktrees[params.worktreeId]
      if (!meta) throw new RpcError('gone', `worktree ${params.worktreeId}`)
      if (samePath(meta.path, root)) throw new RpcError('rejected', 'The main checkout cannot be removed')
      if (meta.status === 'creating') throw new RpcError('rejected', 'The worktree is still being created')
      await document.apply({ kind: 'setWorktree', worktree: { ...meta, status: 'removing' } })

      let branch: string | null = null
      try {
        const listed = await raw.listWorktrees({})
        branch = listed.find((w) => samePath(w.path, meta.path))?.branch ?? null
        const exists = await fsp.stat(meta.path).then((s) => s.isDirectory(), () => false)
        if (exists) {
          await raw.removeWorktree({ targetPath: meta.path, force: params.force })
        } else {
          await raw.pruneWorktrees({})
          deps.paths.removeCheckout(meta.path)
        }
      } catch (err) {
        const current = document.get().worktrees[meta.id]
        if (current) await document.apply({ kind: 'setWorktree', worktree: { ...current, status: meta.status } }).catch(() => {})
        throw err
      }

      const result: WorktreeRemoveResult = {}
      if (branch && params.deleteBranch !== false) {
        try {
          await raw.branchDelete({ name: branch, force: true })
        } catch (err) {
          result.branchDeleteError = errorText(err)
        }
      }
      await applyAll(worktreeRemovalChanges(document.get(), meta.id, {
        closePanels: deps.settings.get('closeWorktreePanelsOnDelete'),
        root,
      }))
      return result
    }).finally(() => monitors.kick()))
  }

  function pruneWorktrees(): Promise<WorktreePruneResult> {
    trust.requireTrusted()
    return joined('prune', () => write(async () => {
      const { output } = await raw.pruneWorktrees({})
      const live = await raw.listWorktrees({})
      if (!live.some((w) => samePath(w.path, root))) {
        throw new Error('Couldn’t verify the live worktrees after cleanup. No saved entries were removed.')
      }
      const liveKeys = new Set(live.map((w) => checkoutPathKey(w.path)))
      const orphans = worktrees().filter((w) =>
        w.status === 'ready' && !samePath(w.path, root) && !liveKeys.has(checkoutPathKey(w.path)))
      const closePanels = deps.settings.get('closeWorktreePanelsOnDelete')
      const changes: DocChange[] = []
      for (const orphan of orphans) {
        deps.paths.removeCheckout(orphan.path)
        changes.push(...worktreeRemovalChanges(document.get(), orphan.id, { closePanels, root }))
      }
      await applyAll(changes)
      return { output, removed: orphans.map((w) => w.id) }
    }).finally(() => monitors.kick()))
  }

  /** Creates and removals run in the write queue, so a record still
   *  `creating` or `removing` seen from inside it was left by a daemon that
   *  stopped midway: a checkout git lists becomes ready, a missing one is
   *  dropped, and a removal is finished (its branch is kept). */
  async function finishInterrupted(live: { path: string }[]): Promise<void> {
    const closePanels = deps.settings.get('closeWorktreePanelsOnDelete')
    for (const meta of worktrees()) {
      if (meta.status === 'ready') continue
      const listed = live.some((w) => samePath(w.path, meta.path))
      try {
        if (meta.status === 'creating') {
          await document.apply(listed ? { kind: 'setWorktree', worktree: { ...meta, status: 'ready' } } : { kind: 'removeWorktree', id: meta.id })
          continue
        }
        if (listed) await raw.removeWorktree({ targetPath: meta.path, force: true })
        else deps.paths.removeCheckout(meta.path)
        await applyAll(worktreeRemovalChanges(document.get(), meta.id, { closePanels, root }))
      } catch (err) {
        deps.log?.warn('finishing the interrupted %s of %s failed: %s', meta.status, meta.path, errorText(err))
      }
    }
  }

  async function reconcileWorktrees(): Promise<void> {
    if (!trust.isTrusted()) return
    await write(async () => {
      if (!(await raw.isRepo({}))) return
      await finishInterrupted(await raw.listWorktrees({}))
      const live = await raw.listWorktrees({})
      const known = worktrees()
      const added: WorktreeMeta[] = []
      for (const wt of live) {
        if (wt.isBare || [...known, ...added].some((w) => samePath(w.path, wt.path))) continue
        added.push({ id: newId(), path: wt.path, color: pickWorktreeColor([...known, ...added]), status: 'ready' })
      }
      await applyAll(added.map((worktree) => ({ kind: 'setWorktree', worktree })))
    })
  }

  return {
    root,
    git,
    github,
    monitors,
    trustChanged: () => monitors.kick(),
    resolveDir: async (cwd) => deps.paths.resolveDir(cwd ?? root),
    createWorktree,
    removeWorktree,
    pruneWorktrees,
    reconcileWorktrees,
    snapshot,
    dispose() {
      monitors.dispose()
      rawGithub.dispose()
    },
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The `vcs` capability: the repository runtime's git, gh and monitors,
 *  which check trust themselves. */
export function vcsCapabilityImpl(repo: RepositoryRuntime): CapabilityImpl<VcsCapability> {
  const { git, github } = repo
  return {
    ...git,
    worktreeCreate: (p) => repo.createWorktree(p),
    worktreeRemove: (p) => repo.removeWorktree(p),
    worktreePrune: () => repo.pruneWorktrees(),
    prContext: ({ repository, number }) => github.pullRequestContext(repository, number),
    githubConnection: () => github.connection(),
    githubLogin: ({ operation }, ctx) => {
      const owner = ctx.connection.id
      if (operation === 'start') return github.startLogin(owner)
      if (operation === 'cancel') github.cancelLogin(owner)
      return github.loginState(owner)
    },
    pullRequests: ({ refresh }) => github.pullRequests(refresh === true),
    status: async ({ cwd }, sink) => {
      const dir = await repo.resolveDir(cwd)
      let rev = -1
      return repo.monitors.subscribe(dir, (status) => {
        rev++
        sink.emit(rev === 0 ? { kind: 'snapshot', rev, snapshot: status } : { kind: 'change', rev, change: status })
      })
    },
  }
}
