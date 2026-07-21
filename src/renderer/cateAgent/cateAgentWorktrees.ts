// =============================================================================
// cateAgentWorktrees — the single worktree-teardown primitive, shared by the
// tools layer (round-discard / select_winner) and the review actions (merge /
// discard / dismiss). Resolving a worktree record by id and dropping it from
// disk + store (checkout, additional root, territory) used to be reimplemented
// three ways (removeWorktreeById, cleanupWorktree, the teardownRunWork loop);
// they all funnel through here now so the cleanup stays identical everywhere.
//
// Leaf module: depends only on the app/git stores, so both cateAgentTools and
// cateAgentReviewActions can import it without a cycle.
// =============================================================================

import type { WorktreeMeta } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { gitStatusStore } from '../stores/gitStatusStore'
import log from '../lib/logger'

/** Resolve a worktree's metadata record by id within a workspace. */
export function worktreeMetaFor(wsId: string, worktreeId: string | undefined): WorktreeMeta | undefined {
  if (!worktreeId) return undefined
  const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
  return ws?.worktrees?.find((w) => w.id === worktreeId)
}

/** The branch currently checked out in a worktree, by id — the live git fact, never
 *  the denormalized copy. Mirrors the id rule in `useWorktrees`: a worktree with no
 *  persisted metadata (the primary, normally) is keyed by its own path. Undefined
 *  when the id is unknown or its checkout is gone. */
export function worktreeBranchFor(wsId: string, rootPath: string, worktreeId: string | null | undefined): string | undefined {
  if (!worktreeId) return undefined
  const path = worktreeMetaFor(wsId, worktreeId)?.path ?? worktreeId
  return gitStatusStore.getSnapshot(rootPath).worktrees.find((w) => w.path === path)?.branch || undefined
}

/** Tear down a worktree by id: remove the checkout from disk (best-effort) and
 *  drop its store records (worktree entry + additional root) before refreshing
 *  git status. No-op for an unknown/cleared id, so it's safe to fire on dead
 *  refs. `force` defaults to true — the agent's worktrees are ephemeral and
 *  usually dirty; pass `force: false` for a clean merge where an unexpectedly
 *  dirty tree should abort the remove instead. */
export async function teardownWorktree(
  wsId: string,
  rootPath: string,
  worktreeId: string | undefined,
  opts: { force?: boolean } = {},
): Promise<void> {
  const meta = worktreeMetaFor(wsId, worktreeId)
  if (!meta) return
  try {
    await window.electronAPI.gitWorktreeRemove(rootPath, meta.path, { force: opts.force ?? true }, wsId)
  } catch (err) {
    log.warn('[cateAgent] worktree remove failed: %O', err)
  }
  const app = useAppStore.getState()
  app.removeWorktree(wsId, meta.id)
  app.removeAdditionalRoot(wsId, meta.path)
  gitStatusStore.refresh(rootPath)
}
