// =============================================================================
// useWorktrees — single read-time join of the LIVE worktree list (owned by
// gitStatusStore) with the UI-owned metadata persisted in appStore.worktrees.
//
// The worktree list used to live in three places kept in sync by hand: the live
// `git worktree list` (refetched ad-hoc in ParallelWorkTab, SourceControlView
// and Canvas), the ParallelWorkTab component state, and the persisted
// appStore.worktrees (which denormalizes branch/isPrimary and had to be
// re-synced to git on every reconcile loop). gitStatusStore now owns the live
// path/branch/isPrimary/isCurrent facts; appStore.worktrees should carry only
// UI metadata (id/color/label) keyed by path. This hook joins the two so every
// consumer derives the same view from one source.
//
// NOTE for the integrator: appStore.worktrees still denormalizes branch and
// isPrimary (appStore is owned by another track). The join below treats the
// LIVE git facts as authoritative for branch/isPrimary/isCurrent and uses the
// persisted record only for id/color/label, so the denormalized fields are no
// longer load-bearing at read time. A follow-up on the appStore track should
// drop branch/isPrimary from WorktreeMeta and persist only UI metadata keyed by
// path.
// =============================================================================

import { useMemo } from 'react'
import { useAppStore } from './appStore'
import { useGitStatusSnapshot, type GitWorktreeEntry } from './gitStatusStore'
import type { WorktreeMeta } from '../../shared/types'

/** A worktree as the UI should see it: live git facts joined with persisted UI
 *  metadata. Live facts (branch/isPrimary/isCurrent) win over the denormalized
 *  copies in the persisted record. */
export interface JoinedWorktree {
  /** Stable UI id (from the persisted metadata, falls back to the path). */
  id: string
  path: string
  /** Live branch (from git), falling back to the persisted copy. */
  branch: string
  /** Live primary flag (path === workspace rootPath). */
  isPrimary: boolean
  /** Live current-worktree flag (the checkout HEAD currently points at). */
  isCurrent: boolean
  /** UI accent color from persisted metadata, if any. */
  color?: string
  /** Friendly label from persisted metadata, if any. */
  label?: string
  /** True when there is persisted metadata but no live git worktree (orphan). */
  isOrphan: boolean
}

/** Join the live worktree list for `rootPath` with the workspace's persisted
 *  UI metadata. Returns one entry per live worktree plus any orphaned metadata
 *  (persisted non-primary worktrees whose checkout no longer exists). */
export function useWorktrees(rootPath: string, workspaceId: string): JoinedWorktree[] {
  const snapshot = useGitStatusSnapshot(rootPath)
  const meta = useAppStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.worktrees,
  )

  return useMemo(() => {
    const metaByPath = new Map<string, WorktreeMeta>()
    for (const m of meta ?? []) metaByPath.set(m.path, m)

    const seen = new Set<string>()
    const joined: JoinedWorktree[] = snapshot.worktrees.map((g: GitWorktreeEntry) => {
      seen.add(g.path)
      const m = metaByPath.get(g.path)
      return {
        id: m?.id ?? g.path,
        path: g.path,
        branch: g.branch || m?.branch || '',
        isPrimary: g.isPrimary,
        isCurrent: g.isCurrent,
        color: m?.color,
        label: m?.label,
        isOrphan: false,
      }
    })

    // Orphans: persisted non-primary metadata whose live worktree is gone.
    for (const m of meta ?? []) {
      if (seen.has(m.path) || m.isPrimary) continue
      joined.push({
        id: m.id,
        path: m.path,
        branch: m.branch,
        isPrimary: false,
        isCurrent: false,
        color: m.color,
        label: m.label,
        isOrphan: true,
      })
    }

    return joined
    // snapshot.worktrees identity changes per applied snapshot (see
    // gitStatusStore), so it captures every refresh without needing revision.
  }, [snapshot.worktrees, meta])
}
