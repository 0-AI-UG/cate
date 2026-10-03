// "Open in Cate" for a pull request: check it out into its own worktree in
// this workspace, make sure each worktree panel type runs there, and open a review
// of the PR's changes.

import type { RuntimeProxy } from '@kernel/rpc/contract'
import type { PullRequestItem } from '@workspace/repository/contract'
import type { RepositoryUiHost } from './context'

/** Opens `pr` in the workspace. Resolves false when the workspace's origin is
 *  not the PR's repository (the client tries its other workspaces). */
export async function openPullRequest(
  pr: PullRequestItem,
  host: Pick<RepositoryUiHost, 'worktrees' | 'panels' | 'launchTypes' | 'launchInWorktree' | 'openReview'>,
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
