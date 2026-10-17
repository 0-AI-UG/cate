// Worktree reads a view makes on demand: the per-checkout dirty status and PR
// state (one `git status` and one `gh` lookup each, so only while a view that
// shows them is open). The live list itself is `joinWorktrees` over the
// document's metadata and the root's status snapshot.

import type { CapabilityProxy } from '@kernel/rpc/contract'
import type { JoinedWorktree, PrStatusResult, VcsCapability, WorktreeStatusResult } from '../contract'

export type WorktreeStatusClient = Pick<CapabilityProxy<VcsCapability>, 'worktreeStatus' | 'prStatus'>

/** Dirty status by checkout path; checkouts that fail are left out. */
export async function fetchWorktreeStatuses(
  vcs: WorktreeStatusClient,
  worktrees: readonly JoinedWorktree[],
): Promise<Record<string, WorktreeStatusResult>> {
  const entries = await Promise.all(worktrees.filter((w) => !w.isOrphan).map(async (w) => {
    const status = await vcs.worktreeStatus({ path: w.path }).catch(() => null)
    return status ? [w.path, status] as const : null
  }))
  return Object.fromEntries(entries.filter((e) => e !== null))
}

/** PR state by checkout path, for non-primary checkouts on a branch (or
 *  created from a PR). */
export async function fetchWorktreePrs(
  vcs: WorktreeStatusClient,
  worktrees: readonly JoinedWorktree[],
): Promise<Record<string, PrStatusResult>> {
  const targets = worktrees.filter((w) => !w.isPrimary && !w.isOrphan && (w.branch || w.prNumber))
  const entries = await Promise.all(targets.map(async (w) => {
    const pr = await vcs.prStatus({ path: w.path, branch: w.prNumber ? String(w.prNumber) : w.branch }).catch(() => null)
    return pr ? [w.path, pr] as const : null
  }))
  return Object.fromEntries(entries.filter((e) => e !== null))
}
