// The repository flows every client runs: opening a pull request in Cate,
// publishing, updating, merging, discarding and pruning worktrees, cleaning
// up merged branches, and switching a panel to another checkout.

import { isRpcError, type RuntimeProxy } from '@kernel/rpc/contract'
import { clientUi, errorMessage } from '@kernel/interaction'
import type { DocChange, PanelId } from '@workspace/document/contract'
import { boundWorktreeId, toBranchName, type JoinedWorktree, type PullRequestItem } from '../contract'
import type { RepositoryHost } from './host'

// "Open in Cate" for a pull request: check it out into its own worktree in
// this workspace, make sure each worktree panel type runs there, and open a
// review of the PR's changes.

/** A new worktree on branch `rawName` (made a valid branch name; the name as
 *  typed stays its label when it differs), from `baseRef` when given. */
export function createWorktree(runtime: Pick<RuntimeProxy, 'vcs'>, rawName: string, baseRef?: string) {
  const branch = toBranchName(rawName)
  if (!branch) throw new Error('Please enter a name')
  const label = rawName.trim() !== branch ? rawName.trim() : undefined
  return runtime.vcs.worktreeCreate({ branch, ...(baseRef ? { base: baseRef } : {}), ...(label ? { label } : {}) })
}

/** A new worktree checking out pull request `pr`, labelled with its number. */
export function checkoutPullRequest(runtime: Pick<RuntimeProxy, 'vcs'>, pr: { number: number; headRefName: string }) {
  return runtime.vcs.worktreeCreate({ branch: pr.headRefName, fromPr: pr.number, label: `#${pr.number} ${pr.headRefName}` })
}

/** Opens `pr` in the workspace. Resolves false when the workspace's origin is
 *  not the PR's repository (the client tries its other workspaces). */
export async function openPullRequest(
  pr: PullRequestItem,
  host: Pick<RepositoryHost, 'worktrees' | 'panels' | 'launchTypes' | 'launchInWorktree' | 'openReview'>,
  runtime: Pick<RuntimeProxy, 'vcs'>,
): Promise<boolean> {
  const context = await runtime.vcs.prContext({ repository: pr.repository, number: pr.number })
  if (!context) return false
  const worktree = host.worktrees.find((wt) => wt.prNumber === pr.number)
    ?? await checkoutPullRequest(runtime, { number: pr.number, headRefName: context.headRefName })
  for (const { type } of host.launchTypes.filter((launch) => launch.switches)) {
    if (host.panels.some((panel) => panel.type === type && panel.worktreeId === worktree.id)) continue
    if (!(await host.launchInWorktree(worktree, type))) return true
  }
  await host.openReview({
    repoPath: worktree.path,
    spec: { kind: 'branch', base: context.baseOid, target: 'HEAD' },
    title: `#${pr.number} ${pr.title}`,
  })
  return true
}

export function pullRequestNotOpenMessage(pr: Pick<PullRequestItem, 'repository'>): string {
  return `Open your local ${pr.repository} project in Cate first, then try again. Its origin remote must point to this GitHub repository.`
}

const isMissing = (err: unknown) =>
  isRpcError(err, 'gone') || /\bENOENT\b|no such file or directory/i.test(String(err))

/** Discards a worktree after asking: deletes its checkout and branch and
 *  closes its panels. Failures go to `setError`; `setBusy` brackets the
 *  removal. */
export async function discardWorktree(
  wt: JoinedWorktree,
  deps: {
    host: Pick<RepositoryHost, 'root' | 'worktreePanelSummary' | 'prepareWorktreeClose'>
    runtime: Pick<RuntimeProxy, 'vcs' | 'file'>
    setError(message: string | null): void
    setBusy?(worktreeId: string | null): void
  },
): Promise<void> {
  const { host, runtime, setError, setBusy } = deps
  if (!host.root || wt.isPrimary) return
  const label = wt.label || wt.branch || wt.path
  // Fresh status so the warnings and the force flag are right whichever
  // surface asked.
  let status: Awaited<ReturnType<typeof runtime.vcs.worktreeStatus>> = null
  try {
    status = await runtime.vcs.worktreeStatus({ path: wt.path })
  } catch (err: unknown) {
    setError(`Couldn’t verify this worktree before discarding it: ${errorMessage(err, 'Status is unavailable.')}`)
    return
  }
  let missing = false
  if (!status) {
    try {
      await runtime.file.stat({ path: wt.path })
    } catch (err: unknown) {
      missing = isMissing(err)
    }
    if (!missing) {
      setError('Couldn’t verify this worktree before discarding it. No files were removed.')
      return
    }
  }
  const dirty = !!status?.dirty
  const branchAhead = (status?.ahead ?? 0) > 0
  const panels = host.worktreePanelSummary(wt.id)
  const ok = await clientUi().confirm(
    `Discard “${label}”?\n\n` +
      `This deletes the parallel branch and everything in it.\n` +
      (panels.count ? `\nIts ${panels.count} open ${panels.count === 1 ? 'panel' : 'panels'} will be closed.` : '') +
      (dirty ? '\nWARNING: uncommitted changes here will be lost.' : '') +
      (panels.hasDirtyEditor ? '\nWARNING: an editor has unsaved changes.' : '') +
      (branchAhead ? `\nWARNING: ${status?.ahead} unpublished commit(s) will be lost.` : '') +
      (missing ? '\nThe worktree folder is missing. Its Git record and branch will be removed.' : ''),
  )
  if (!ok) return
  if (!(await host.prepareWorktreeClose(wt.id))) return
  // Saving an editor while asking may have dirtied the checkout since the
  // first check; re-read before choosing git's force flag.
  let removalDirty = dirty
  if (!missing) {
    try {
      removalDirty = !!(await runtime.vcs.worktreeStatus({ path: wt.path }))?.dirty
    } catch (err: unknown) {
      setError(`Couldn’t re-verify this worktree before discarding it: ${errorMessage(err, 'Status is unavailable.')}`)
      return
    }
  }
  setBusy?.(wt.id)
  try {
    const result = await runtime.vcs.worktreeRemove({
      worktreeId: wt.id,
      force: dirty || removalDirty || panels.hasDirtyEditor,
    })
    if (result.branchDeleteError && wt.branch) {
      setError(`Removed, but branch ${wt.branch} could not be deleted: ${result.branchDeleteError}`)
    }
  } catch (err: unknown) {
    setError(`Discard failed: ${errorMessage(err, 'The worktree was not removed.')}`)
  } finally {
    setBusy?.(null)
  }
}

/** What the worktree flows report through: failures go to `setError` (null
 *  clears it); `setBusy` brackets a slow runtime call. */
interface WorktreeFlowDeps {
  runtime: Pick<RuntimeProxy, 'vcs'>
  setError(message: string | null): void
  setBusy?(worktreeId: string | null): void
}

/** Pushes the worktree's branch to origin. */
export async function publishWorktree(wt: JoinedWorktree, deps: WorktreeFlowDeps): Promise<void> {
  const { runtime, setError, setBusy } = deps
  if (!wt.branch) return
  setError(null)
  setBusy?.(wt.id)
  try {
    await runtime.vcs.push({ cwd: wt.path, remote: 'origin', branch: wt.branch })
  } catch (err: unknown) {
    setError(`Publish failed: ${errorMessage(err, 'Couldn’t publish this branch.')}`)
  } finally {
    setBusy?.(null)
  }
}

/** Creates a pull request for the worktree's branch and opens it. A worktree
 *  that already belongs to a PR is refused. */
export async function createWorktreePr(wt: JoinedWorktree, deps: WorktreeFlowDeps & { onPrCreated?(): void }): Promise<void> {
  const { runtime, setError, setBusy, onPrCreated } = deps
  if (!wt.branch) return
  if (wt.prNumber) {
    setError(`This worktree already belongs to PR #${wt.prNumber}. Open that pull request instead.`)
    return
  }
  setError(null)
  setBusy?.(wt.id)
  try {
    const res = await runtime.vcs.createPr({ path: wt.path, branch: wt.branch })
    if (res.ok) {
      clientUi().openExternal(res.url)
      onPrCreated?.()
    } else {
      setError(errorMessage(res.message, 'Couldn’t create the pull request.'))
    }
  } catch (err: unknown) {
    setError(`Couldn’t create pull request: ${errorMessage(err, 'The operation failed.')}`)
  } finally {
    setBusy?.(null)
  }
}

/** Brings branch `base` into the worktree; conflicts are left for the person
 *  to resolve there. */
export async function updateWorktreeFromBase(wt: JoinedWorktree, base: string, deps: WorktreeFlowDeps): Promise<void> {
  const { runtime, setError, setBusy } = deps
  if (wt.isPrimary || !wt.branch) return
  if (!base) {
    setError('Could not resolve the base branch. Open Source Control once to refresh.')
    return
  }
  setBusy?.(wt.id)
  try {
    const result = await runtime.vcs.worktreeUpdateFrom({ path: wt.path, from: base })
    if (!result.ok) {
      setError(result.conflict
        ? `Conflicts updating from ${base} — open a terminal here to resolve them.`
        : `Update from ${base}: ${errorMessage(result.message, 'The update failed.')}`)
    } else {
      setError(null)
    }
  } catch (err: unknown) {
    setError(`Update failed: ${errorMessage(err, 'The operation failed.')}`)
  } finally {
    setBusy?.(null)
  }
}

/** Merges the worktree's branch into branch `base` after asking. */
export async function mergeWorktree(
  wt: JoinedWorktree,
  base: string,
  deps: WorktreeFlowDeps & { host: Pick<RepositoryHost, 'root'> },
): Promise<void> {
  const { host, runtime, setError, setBusy } = deps
  if (!host.root || wt.isPrimary) return
  if (!wt.branch || !base) {
    setError('Could not resolve the base branch — open Source Control once to refresh.')
    return
  }
  if (!(await clientUi().confirm(`Merge ${wt.branch} into ${base}?`))) return
  setBusy?.(wt.id)
  try {
    const result = await runtime.vcs.worktreeMergeTo({ cwd: host.root, from: wt.branch, to: base })
    if (!result.ok) setError(`Merge ${wt.branch} → ${base}: ${errorMessage(result.message, 'The merge failed.')}`)
    else setError(null)
  } catch (err: unknown) {
    setError(`Merge failed: ${errorMessage(err, 'The operation failed.')}`)
  } finally {
    setBusy?.(null)
  }
}

/** Drops the metadata of worktrees whose checkout is gone, with their bound
 *  panels. Asks about every orphan's panels first; one refusal keeps them
 *  all. */
export async function pruneWorktrees(
  orphans: JoinedWorktree[],
  deps: Omit<WorktreeFlowDeps, 'setBusy'> & { host: Pick<RepositoryHost, 'prepareWorktreeClose'> },
): Promise<void> {
  const { host, runtime, setError } = deps
  try {
    for (const orphan of orphans) {
      if (!(await host.prepareWorktreeClose(orphan.id))) return
    }
    await runtime.vcs.worktreePrune()
  } catch (err: unknown) {
    setError(`Cleanup failed: ${errorMessage(err, 'No saved entries were removed.')}`)
  }
}

/** Drops one orphan's metadata and bound panels. */
export async function removeOrphanWorktree(
  worktreeId: string,
  deps: Omit<WorktreeFlowDeps, 'setBusy'> & { host: Pick<RepositoryHost, 'prepareWorktreeClose'> },
): Promise<void> {
  const { host, runtime, setError } = deps
  if (!(await host.prepareWorktreeClose(worktreeId))) return
  try {
    await runtime.vcs.worktreeRemove({ worktreeId, force: true })
  } catch (err: unknown) {
    setError(`Couldn’t remove this entry: ${errorMessage(err, 'The operation failed.')}`)
  }
}

/** Deletes the local branches other than `current` after asking; git refuses
 *  unmerged or in-use ones, which are kept. Resolves how many were kept, or
 *  null when the person cancelled. */
export async function deleteMergedBranches(
  runtime: Pick<RuntimeProxy, 'vcs'>,
  root: string,
  current: string,
  branches: readonly string[],
): Promise<number | null> {
  const candidates = branches.filter((name) => name !== current)
  if (candidates.length === 0) return 0
  if (!await clientUi().confirm(`Delete local branches already merged into ${current || 'the current checkout'}? Unmerged or in-use branches will be kept.`)) return null
  let kept = 0
  for (const name of candidates) {
    try {
      await runtime.vcs.branchDelete({ cwd: root, name })
    } catch {
      kept++
    }
  }
  return kept
}

/** Moves a panel to the checkout at `picked`. A type that switches live
 *  (`switches`, its definition's `switchesWorktree`) switches through its
 *  session, which may refuse with `dirty` while something runs: the person is
 *  asked, and the switch is sent again with `discard`. Others just rebind
 *  the record. */
export async function switchPanelWorktree(deps: {
  panelId: PanelId
  picked: string
  root: string
  switches: boolean
  runtime: Pick<RuntimeProxy, 'session'>
  propose(change: DocChange): void
}): Promise<void> {
  const { panelId, runtime } = deps
  const worktreeId = boundWorktreeId(deps.picked, deps.root)
  if (!deps.switches) {
    deps.propose({ kind: 'updatePanel', id: panelId, patch: { worktreeId } })
    return
  }
  const send = (discard: boolean) => runtime.session.op({ panelId, op: { kind: 'switchWorktree', worktreeId, ...(discard ? { discard } : {}) } })
  try {
    await send(false)
  } catch (err) {
    if (!isRpcError(err, 'dirty')) throw err
    if (await clientUi().confirm(`${err.message}. Stop it and switch the worktree?`)) await send(true)
  }
}
