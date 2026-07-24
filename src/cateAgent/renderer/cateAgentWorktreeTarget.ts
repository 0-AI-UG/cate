// =============================================================================
// cateAgentWorktreeTarget — the WORKTREE a chat works against, picked in the
// composer's worktree pill. The main agent uses it as its cwd. Stored as the
// worktree's stable id (never a branch name or path).
//
// Kept per-chat in localStorage, like the composer draft — ephemeral across
// restarts. Resolve an id to its live branch with `worktreeBranchFor`.
// =============================================================================

const key = (chatId: string): string => `cate.targetWorktree.${chatId}`

export const getTargetWorktree = (chatId: string): string | null => {
  try {
    return chatId ? localStorage.getItem(key(chatId)) : null
  } catch {
    return null
  }
}

/** A chat's explicit target wins; a newly-created Agent panel falls back to
 * the worktree it was launched from until the chat records its own choice. */
export const resolveTargetWorktree = (
  chatId: string,
  defaultWorktreeId?: string,
): string | null => getTargetWorktree(chatId) ?? defaultWorktreeId ?? null

export const setTargetWorktree = (chatId: string, worktreeId: string | null): void => {
  try {
    if (!chatId) return
    if (worktreeId) localStorage.setItem(key(chatId), worktreeId)
    else localStorage.removeItem(key(chatId))
  } catch {
    /* best-effort */
  }
}
