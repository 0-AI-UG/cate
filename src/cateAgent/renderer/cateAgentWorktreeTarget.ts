// =============================================================================
// cateAgentWorktreeTarget — the WORKTREE a chat works against, picked in the
// composer's worktree pill. It answers both halves of a run's git story with one
// choice: the run's ephemeral worktrees branch OFF this worktree's branch, and the
// winner merges back INTO it. Stored as the worktree's stable id (never a branch
// name or a path, both of which move) so it survives a rename.
//
// Kept per-chat in localStorage, like the composer draft — ephemeral across
// restarts, which is fine: the review card is where you land, and the target is
// re-pickable there. Resolve an id to its live branch with `worktreeBranchFor`.
// =============================================================================

const key = (chatId: string): string => `cate.targetWorktree.${chatId}`

export const getTargetWorktree = (chatId: string): string | null => {
  try {
    return chatId ? localStorage.getItem(key(chatId)) : null
  } catch {
    return null
  }
}

export const setTargetWorktree = (chatId: string, worktreeId: string | null): void => {
  try {
    if (!chatId) return
    if (worktreeId) localStorage.setItem(key(chatId), worktreeId)
    else localStorage.removeItem(key(chatId))
  } catch {
    /* best-effort */
  }
}
