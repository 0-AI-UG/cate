// Worktrees as views show them: the live checkout list of the root's status
// joined with the document's metadata.

import { useMemo } from 'react'
import type { WorktreeMeta } from '@workspace/document/contract'
import { joinWorktrees, samePath, type JoinedWorktree } from '../contract'
import { useRepositoryUi } from './context'
import { useGitStatus } from './gitStatus'

/** The joined worktrees of `root`. Metadata belongs to the workspace's own
 *  repository, so a nested repository shows only its live checkouts. */
export function useJoinedWorktrees(
  workspaceId: string,
  workspaceRoot: string,
  meta: readonly WorktreeMeta[],
  root: string = workspaceRoot,
): JoinedWorktree[] {
  const snapshot = useGitStatus(workspaceId, root)
  const own = root && workspaceRoot && samePath(root, workspaceRoot)
  return useMemo(
    () => (root ? joinWorktrees(root, own ? meta : [], snapshot.worktrees) : []),
    [root, own, meta, snapshot.worktrees],
  )
}

/** Joined worktrees of the context's workspace (or of a nested `root`). */
export function useWorktrees(root?: string): JoinedWorktree[] {
  const host = useRepositoryUi()
  return useJoinedWorktrees(host.workspaceId, host.root, host.worktrees, root ?? host.root)
}

export function worktreeLabel(worktree: Pick<JoinedWorktree, 'label' | 'branch' | 'isPrimary'>): string {
  return worktree.label || worktree.branch || (worktree.isPrimary ? 'main' : '(detached)')
}
