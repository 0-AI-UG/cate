// =============================================================================
// Worktree tag resolution — shared by the terminal and agent panels so both
// anchor a worktree-tagged panel to the SAME checkout deterministically.
//
// A panel's `worktreeId` is the registry record's stable id. Paths are mutable
// checkout details and are never accepted as identifiers.
// =============================================================================

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
  return worktrees.find((w) => w.id === worktreeId)
}
