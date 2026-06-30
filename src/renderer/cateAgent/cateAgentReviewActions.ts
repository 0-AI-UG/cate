// =============================================================================
// cateAgentReviewActions — the user's "land it" gate for a todo in `review`.
//
// A finished orchestrator leaves its work on the todo's worktree branch. The user
// picks one outcome here: Merge it into the current branch, open a PR, or discard
// it. The Cate Agent never lands work itself. Each action tidies the worktree
// (checkout + registry + territory) and moves the todo to its terminal status.
// =============================================================================

import type { Todo } from '../../shared/types'
import { useTodosStore } from '../stores/todosStore'
import { closeCanvasPanel } from './cateAgentTerminals'
import { worktreeMetaFor, teardownWorktree } from './cateAgentWorktrees'
import log from '../lib/logger'

export interface ReviewResult {
  ok: boolean
  message?: string
}

/** Merge the todo's branch into the current branch, then tidy up. */
export async function mergeTodo(wsId: string, rootPath: string, todo: Todo): Promise<ReviewResult> {
  const meta = worktreeMetaFor(wsId, todo.worktreeId)
  if (!meta || !todo.branch) return { ok: false, message: 'No worktree to merge' }
  let toBranch = 'main'
  try {
    const status = await window.electronAPI.gitStatus(rootPath)
    if (status.current) toBranch = status.current
  } catch {
    /* fall back to main */
  }
  const res = await window.electronAPI.gitWorktreeMergeTo(rootPath, todo.branch, toBranch)
  if (!res.ok) {
    const message = res.conflict ? `Merge conflict with ${toBranch}` : res.message
    useTodosStore.getState().patchTodo(rootPath, todo.id, { note: message })
    return { ok: false, message }
  }
  await teardownWorktree(wsId, rootPath, meta.id, { force: false })
  useTodosStore.getState().patchTodo(rootPath, todo.id, { status: 'done', note: `Merged into ${toBranch}` })
  return { ok: true }
}

/** Push the branch and open a PR. Leaves the worktree in place (PR is live). */
export async function openPrTodo(wsId: string, rootPath: string, todo: Todo): Promise<ReviewResult> {
  const meta = worktreeMetaFor(wsId, todo.worktreeId)
  if (!meta || !todo.branch) return { ok: false, message: 'No worktree for PR' }
  const res = await window.electronAPI.gitCreatePR(meta.path, todo.branch)
  if (!res.ok) {
    useTodosStore.getState().patchTodo(rootPath, todo.id, { note: res.message })
    return { ok: false, message: res.message }
  }
  useTodosStore.getState().patchTodo(rootPath, todo.id, { status: 'done', note: `PR: ${res.url}` })
  try {
    await window.electronAPI.openExternalUrl?.(res.url)
  } catch {
    /* best-effort open */
  }
  return { ok: true, message: res.url }
}

/** Remove the worktrees + terminals a todo's run left behind. Closes every terminal
 *  it opened and removes its worktree plus each iteration's worktree (force). The
 *  iteration/worktree layer is ephemeral — it is never resumed, only the orchestrator
 *  is — so an interrupt/rerun/discard wipes it whole. May also delete the branch.
 *  Operates on the passed snapshot and does NOT touch the todo store — callers patch
 *  the todo's now-dead refs themselves, so this is safe to fire-and-forget while the
 *  caller updates state synchronously. */
export async function teardownTodoWork(
  wsId: string,
  rootPath: string,
  todo: Todo,
  opts: { deleteBranch?: boolean } = {},
): Promise<void> {
  // Close every terminal the todo opened (the run's own + each iteration's).
  for (const tid of todo.terminalNodeIds ?? []) closeCanvasPanel(wsId, tid)

  // Tear down the run's worktree plus any extra iteration worktrees (a loop todo
  // can leave several behind).
  const worktreeIds = new Set<string>()
  if (todo.worktreeId) worktreeIds.add(todo.worktreeId)
  for (const it of todo.iterations ?? []) if (it.worktreeId) worktreeIds.add(it.worktreeId)
  for (const id of worktreeIds) await teardownWorktree(wsId, rootPath, id)

  if (opts.deleteBranch && todo.branch) {
    try {
      await window.electronAPI.gitBranchDelete(rootPath, todo.branch, true)
    } catch (err) {
      log.warn('[cateAgentReview] branch delete failed: %O', err)
    }
  }
}

/** Remove a todo's card entirely, first tearing down any worktree/branch/terminals
 *  its run left behind. Use this for the Remove/Dismiss buttons instead of the bare
 *  store `removeTodo`, so dropping a `failed` (or otherwise still-provisioned) card
 *  doesn't orphan its worktree on disk + in git. Teardown is a no-op when the todo
 *  has no live worktree, so this is safe for `suggested`/`pending` cards too. */
export async function removeTodoWithCleanup(wsId: string, rootPath: string, todo: Todo): Promise<void> {
  await teardownTodoWork(wsId, rootPath, todo, { deleteBranch: true })
  useTodosStore.getState().removeTodo(rootPath, todo.id)
}

/** Throw away the worktree(s) + branch and close the terminals the todo opened,
 *  but KEEP the todo (status `discarded`) so the user can rerun it. Clears the
 *  now-deleted worktree/branch/terminals so a rerun starts from a clean slate. */
export async function discardTodo(wsId: string, rootPath: string, todo: Todo): Promise<ReviewResult> {
  await teardownTodoWork(wsId, rootPath, todo, { deleteBranch: true })
  useTodosStore.getState().patchTodo(rootPath, todo.id, {
    status: 'discarded',
    note: 'Discarded',
    worktreeId: undefined,
    branch: undefined,
    terminalNodeIds: undefined,
  })
  return { ok: true }
}
