// =============================================================================
// worktreeSync — keep workspace.worktrees in sync with the actual git worktrees.
//
// useProcessMonitor calls this on workspace mount and every GIT_BRANCH_UPDATE,
// so the store (which drives the canvas worktree territories + pills) stays
// current for every workspace without any worktree UI being open.
//
// This handles only the cheap list/metadata reconcile (one `git worktree list`).
// Per-worktree dirty status and `gh` PR lookups live in useWorktreeStatuses —
// those are expensive and only fetched while the toolbar drop-up is open.
// =============================================================================

import { useAppStore, pickWorktreeColor } from '../stores/appStore'
import { pathKey } from '../../shared/pathUtils'
import type { WorktreeMeta } from '../../shared/types'

export interface GitWorktree {
  path: string
  branch: string
  isBare: boolean
  isCurrent: boolean
}

export interface WorktreeSyncResult {
  /** Whether the workspace root is a git repo. Non-repos return an empty list. */
  isRepo: boolean
  gitWorktrees: GitWorktree[]
}

function newWorktreeId(): string {
  return `wt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Reconcile the store's worktree metadata for one workspace against the git
 * worktrees on disk: add newly-discovered worktrees, update branch names that
 * changed, and ensure the primary worktree exists. It does NOT remove worktrees
 * that vanished from git — those surface as "orphans" in the sidebar so the user
 * can decide, matching the prior in-component behavior.
 *
 * Returns the git worktree list (and whether the root is a repo) so a foreground
 * caller can drive its own view state, or null when the workspace has no root.
 */
export async function syncWorktrees(workspaceId: string): Promise<WorktreeSyncResult | null> {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
  const rootPath = ws?.rootPath
  if (!ws || !rootPath) return null

  // Gate everything on being a git repo so we never fire branch/worktree
  // commands (and log noisy errors) in a plain folder.
  const repo = await window.electronAPI.gitIsRepo(rootPath).catch(() => false)
  if (!repo) return { isRepo: false, gitWorktrees: [] }

  const list = await window.electronAPI.gitWorktreeList(rootPath)

  const store = useAppStore.getState()
  store.ensurePrimaryWorktree(workspaceId)

  // Re-read after ensurePrimaryWorktree so we diff against the freshest list.
  const current = store.workspaces.find((w) => w.id === workspaceId)
  if (current) {
    const existing = current.worktrees ?? []
    // Match on a normalized key, not raw strings: git reports forward-slash
    // paths while rootPath/stored paths use the native separator, so on Windows
    // raw `===` would never match and every worktree would be re-added.
    // worktrees carry only UI metadata (id/color/label) now; branch/isPrimary are
    // live git facts joined in at read time (see useWorktrees), so we just need
    // to ensure a metadata record exists for every git worktree we discover.
    for (const g of list) {
      const gKey = pathKey(g.path)
      const match = existing.find((w) => pathKey(w.path) === gKey)
      if (!match) {
        const meta: WorktreeMeta = {
          id: newWorktreeId(),
          path: g.path,
          color: pickWorktreeColor(existing),
        }
        store.upsertWorktree(workspaceId, meta)
      }
    }
  }

  return { isRepo: true, gitWorktrees: list }
}
