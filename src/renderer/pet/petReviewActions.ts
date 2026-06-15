// =============================================================================
// petReviewActions — the user's "land it" gate for a todo in `review`.
//
// A finished executor leaves its work on the todo's worktree branch. The user
// picks one outcome here: Merge it into the current branch, open a PR, or discard
// it. The pet never lands work itself. Each action tidies the worktree (checkout
// + registry + territory) and moves the todo to its terminal status.
// =============================================================================

import type { Todo, WorktreeMeta } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { useTodosStore } from '../stores/todosStore'
import { gitStatusStore } from '../stores/gitStatusStore'
import log from '../lib/logger'

function worktreeMeta(wsId: string, worktreeId: string | undefined): WorktreeMeta | undefined {
  if (!worktreeId) return undefined
  const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
  return ws?.worktrees?.find((w) => w.id === worktreeId)
}

/** Drop the worktree from disk + store (checkout, additional root, territory). */
async function cleanupWorktree(wsId: string, rootPath: string, meta: WorktreeMeta, force: boolean): Promise<void> {
  try {
    await window.electronAPI.gitWorktreeRemove(rootPath, meta.path, { force })
  } catch (err) {
    log.warn('[petReview] worktree remove failed: %O', err)
  }
  const app = useAppStore.getState()
  app.removeWorktree(wsId, meta.id)
  app.removeAdditionalRoot(wsId, meta.path)
  gitStatusStore.refresh(rootPath)
}

export interface ReviewResult {
  ok: boolean
  message?: string
}

/** Merge the todo's branch into the current branch, then tidy up. */
export async function mergeTodo(wsId: string, rootPath: string, todo: Todo): Promise<ReviewResult> {
  const meta = worktreeMeta(wsId, todo.worktreeId)
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
  await cleanupWorktree(wsId, rootPath, meta, false)
  useTodosStore.getState().patchTodo(rootPath, todo.id, { status: 'done', note: `Merged into ${toBranch}` })
  return { ok: true }
}

/** Push the branch and open a PR. Leaves the worktree in place (PR is live). */
export async function openPrTodo(wsId: string, rootPath: string, todo: Todo): Promise<ReviewResult> {
  const meta = worktreeMeta(wsId, todo.worktreeId)
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

/** Throw away the worktree + branch; the todo is marked failed/discarded. */
export async function discardTodo(wsId: string, rootPath: string, todo: Todo): Promise<ReviewResult> {
  const meta = worktreeMeta(wsId, todo.worktreeId)
  if (meta) await cleanupWorktree(wsId, rootPath, meta, true)
  if (todo.branch) {
    try {
      await window.electronAPI.gitBranchDelete(rootPath, todo.branch, true)
    } catch (err) {
      log.warn('[petReview] branch delete failed: %O', err)
    }
  }
  useTodosStore.getState().patchTodo(rootPath, todo.id, { status: 'failed', note: 'Discarded' })
  return { ok: true }
}
