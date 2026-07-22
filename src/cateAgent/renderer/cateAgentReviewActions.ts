// =============================================================================
// cateAgentReviewActions — the user's "land it" gate for a chat run in `review`.
//
// A finished code task leaves its work on the run's worktree branch. The user picks
// one outcome from the run's `result` block: Merge it into the current branch, open a
// PR, or discard it. The Cate Agent never lands work itself. Each action tidies the
// worktree (checkout + registry + territory), clears the run, and stamps the result
// block's `outcome` so the frozen transcript records what happened.
// =============================================================================

import type { Chat, ChatRun } from '../../shared/types'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import { closeCanvasPanel } from './cateAgentTerminals'
import { worktreeMetaFor, worktreeBranchFor, teardownWorktree } from './cateAgentWorktrees'
import { getTargetWorktree, setTargetWorktree } from './cateAgentWorktreeTarget'
import log from '../../renderer/lib/logger'

export interface ReviewResult {
  ok: boolean
  message?: string
}

/** Stamp the run's result block with the land outcome + an optional note. */
function markResult(rootPath: string, chat: Chat, outcome: 'merged' | 'pr' | 'discarded', note?: string): void {
  const result = [...chat.messages].reverse().find((m) => m.kind === 'result')
  if (result) useChatsStore.getState().patchMessage(rootPath, chat.id, result.id, { outcome, ...(note ? { note } : {}) })
}

/** Merge the run's branch into the current branch, then tidy up. */
export async function mergeChat(wsId: string, rootPath: string, chat: Chat): Promise<ReviewResult> {
  const run = chat.run
  const meta = worktreeMetaFor(wsId, run?.worktreeId)
  if (!run || !meta || !run.branch) return { ok: false, message: 'No worktree to merge' }
  // Prefer the branch of the worktree the user picked in the composer; otherwise
  // land into whatever branch is checked out now (falling back to main).
  let toBranch = 'main'
  try {
    const status = await window.electronAPI.gitStatus(rootPath, wsId)
    if (status.current) toBranch = status.current
  } catch {
    /* fall back to main */
  }
  const chosen = worktreeBranchFor(wsId, rootPath, getTargetWorktree(chat.id))
  if (chosen) toBranch = chosen
  const res = await window.electronAPI.gitWorktreeMergeTo(rootPath, run.branch, toBranch, wsId)
  if (!res.ok) {
    const message = res.conflict ? `Merge conflict with ${toBranch}` : res.message
    useChatsStore.getState().patchRun(rootPath, chat.id, { note: message })
    return { ok: false, message }
  }
  await teardownWorktree(wsId, rootPath, meta.id, { force: false })
  markResult(rootPath, chat, 'merged', `Merged into ${toBranch}`)
  setTargetWorktree(chat.id, null)
  useChatsStore.getState().clearRun(rootPath, chat.id)
  return { ok: true }
}

/** Push the branch and open a PR. Leaves the worktree in place (PR is live). */
export async function openPrChat(wsId: string, rootPath: string, chat: Chat): Promise<ReviewResult> {
  const run = chat.run
  const meta = worktreeMetaFor(wsId, run?.worktreeId)
  if (!run || !meta || !run.branch) return { ok: false, message: 'No worktree for PR' }
  const res = await window.electronAPI.gitCreatePR(meta.path, run.branch, wsId)
  if (!res.ok) {
    useChatsStore.getState().patchRun(rootPath, chat.id, { note: res.message })
    return { ok: false, message: res.message }
  }
  markResult(rootPath, chat, 'pr', `PR: ${res.url}`)
  useChatsStore.getState().clearRun(rootPath, chat.id)
  try {
    await window.electronAPI.openExternalUrl?.(res.url)
  } catch {
    /* best-effort open */
  }
  return { ok: true, message: res.url }
}

/** Remove the worktrees + terminals a run left behind. Closes every terminal it
 *  opened and removes its worktree plus each iteration's worktree. The iteration/
 *  worktree layer is ephemeral — it is never resumed, only the chat agent is — so an
 *  interrupt/continue/discard wipes it whole. May also delete the branch. Operates on
 *  the passed snapshot and does NOT touch the chats store — callers clear the run
 *  themselves, so this is safe to fire-and-forget while the caller updates state. */
export async function teardownRunWork(
  wsId: string,
  rootPath: string,
  run: ChatRun,
  opts: { deleteBranch?: boolean } = {},
): Promise<void> {
  // Close every terminal the run opened (its own + each iteration's).
  for (const tid of run.terminalNodeIds ?? []) closeCanvasPanel(wsId, tid)

  // Tear down the run's worktree plus any extra iteration worktrees.
  const worktreeIds = new Set<string>()
  if (run.worktreeId) worktreeIds.add(run.worktreeId)
  for (const it of run.iterations ?? []) if (it.worktreeId) worktreeIds.add(it.worktreeId)
  for (const id of worktreeIds) await teardownWorktree(wsId, rootPath, id)

  if (opts.deleteBranch && run.branch) {
    try {
      await window.electronAPI.gitBranchDelete(rootPath, run.branch, true, wsId)
    } catch (err) {
      log.warn('[cateAgentReview] branch delete failed: %O', err)
    }
  }
}

/** Throw away the run's worktree(s) + branch and close its terminals, then clear the
 *  run (stamping the result block `discarded`). The chat + transcript are kept. */
export async function discardChat(wsId: string, rootPath: string, chat: Chat): Promise<ReviewResult> {
  if (chat.run) await teardownRunWork(wsId, rootPath, chat.run, { deleteBranch: true })
  markResult(rootPath, chat, 'discarded', 'Discarded')
  setTargetWorktree(chat.id, null)
  useChatsStore.getState().clearRun(rootPath, chat.id)
  return { ok: true }
}
