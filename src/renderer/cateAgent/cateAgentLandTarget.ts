// =============================================================================
// cateAgentLandTarget — the branch a chat's winning run should MERGE INTO when the
// user lands it. Chosen in the composer's branch pill; read by mergeChat at land
// time (it overrides the "currently checked-out branch" default). Kept per-chat in
// localStorage, like the composer draft — ephemeral across restarts, which is fine:
// the review card is where you land, and you can re-pick the target there.
// =============================================================================

const key = (chatId: string): string => `cate.landBranch.${chatId}`

export const getLandTarget = (chatId: string): string | null => {
  try {
    return chatId ? localStorage.getItem(key(chatId)) : null
  } catch {
    return null
  }
}

export const setLandTarget = (chatId: string, branch: string | null): void => {
  try {
    if (!chatId) return
    if (branch) localStorage.setItem(key(chatId), branch)
    else localStorage.removeItem(key(chatId))
  } catch {
    /* best-effort */
  }
}
