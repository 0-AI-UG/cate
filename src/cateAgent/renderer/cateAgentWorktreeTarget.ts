// =============================================================================
// cateAgentWorktreeTarget — the WORKTREE a chat works against, picked in the
// composer's worktree pill. The direct agent uses it as its cwd. If the chat is
// transferred, iteration worktrees branch OFF it and the winner merges back INTO
// it. Stored as the worktree's stable id (never a branch name or path).
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
