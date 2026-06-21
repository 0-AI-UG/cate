// =============================================================================
// Worktree tag resolution — shared by the terminal and agent panels so both
// anchor a worktree-tagged panel to the SAME checkout deterministically.
//
// A panel's `worktreeId` is normally the registry record's stable id, but it can
// also be a raw path (the useWorktrees `m?.id ?? g.path` fallback, taken when a
// panel is tagged before a background sync assigns metadata). Match on either so
// a path-valued tag still resolves to its record after a restart, instead of
// silently falling back to the workspace root.
// =============================================================================

import { pathKey } from './pathUtils'

/** Minimal shape both the persisted registry (WorktreeMeta) and the read-time
 *  join (JoinedWorktree) satisfy, so one resolver serves every call site. */
interface WorktreeLike {
  id: string
  path: string
}

export function resolveWorktree<W extends WorktreeLike>(
  worktreeId: string | undefined,
  worktrees: readonly W[] | undefined,
): W | undefined {
  if (!worktreeId || !worktrees) return undefined
  const key = pathKey(worktreeId)
  return worktrees.find((w) => w.id === worktreeId || pathKey(w.path) === key)
}
