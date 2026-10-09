// The repository flows every client runs: opening a pull request in Cate,
// discarding a worktree, and switching a panel to another checkout.

import { isRpcError, type RuntimeProxy } from '@kernel/rpc/contract'
import { clientUi, errorMessage } from '@kernel/interaction'
import type { DocChange, PanelId } from '@workspace/document/contract'
import { boundWorktreeId, type JoinedWorktree, type PullRequestItem } from '../contract'
import type { RepositoryHost } from './host'

// "Open in Cate" for a pull request: check it out into its own worktree in
// this workspace, make sure each worktree panel type runs there, and open a
// review of the PR's changes.

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
    ?? await runtime.vcs.worktreeCreate({
      branch: context.headRefName,
      fromPr: pr.number,
      label: `#${pr.number} ${context.headRefName}`,
    })
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
