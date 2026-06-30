// =============================================================================
// sortWorkspacePanels — the canonical ordering for a workspace's panels in the
// sidebar tree (and, via useWorkspacePanelTree, the Cmd+K palette).
//
// Panels are grouped by worktree FIRST so every terminal/agent panel that lives
// on the same git worktree sits together, then by type, then alphabetically by
// title. The worktree order is: the primary worktree (the checkout at the
// workspace rootPath) first, then the remaining worktrees in registry order.
// Panels with no worktree tag — or a tag that resolves to the primary — group
// with the primary checkout. Kept pure (no store/IPC access) so the grouping is
// unit-testable.
// =============================================================================

import { resolveWorktree } from '../../shared/worktrees'
import { pathKey } from '../../shared/pathUtils'

interface SortablePanel {
  id: string
  type: string
  title?: string
  worktreeId?: string
}

/** Minimal worktree shape the ranker needs (WorktreeMeta satisfies it). */
interface WorktreeLike {
  id: string
  path: string
}

const TYPE_ORDER: Record<string, number> = { canvas: 0, terminal: 1, editor: 2, browser: 3 }

/**
 * Build a `worktreeId -> rank` map placing the primary worktree (the one checked
 * out at `rootPath`) first, then the rest in registry order. Rank 0 is reserved
 * for the primary so untagged panels (which fall back to the primary checkout)
 * naturally sort alongside it.
 */
function buildWorktreeRank(
  worktrees: readonly WorktreeLike[],
  rootPath: string | undefined,
): Map<string, number> {
  const rootK = rootPath ? pathKey(rootPath) : undefined
  const ordered = worktrees
    .slice()
    .sort((a, b) => {
      const ap = rootK && pathKey(a.path) === rootK ? 0 : 1
      const bp = rootK && pathKey(b.path) === rootK ? 0 : 1
      return ap - bp
    })
  const rank = new Map<string, number>()
  ordered.forEach((w, i) => rank.set(w.id, i))
  return rank
}

export function sortWorkspacePanels<P extends SortablePanel>(
  panels: P[],
  worktrees: readonly WorktreeLike[] | undefined,
  rootPath: string | undefined,
): P[] {
  const wts = worktrees ?? []
  const rankById = buildWorktreeRank(wts, rootPath)

  // Untagged panels (and tags that resolve to the primary) share rank 0; an
  // unresolved tag sorts after the known worktrees rather than masquerading as
  // primary.
  const rankOf = (p: P): number => {
    const wt = resolveWorktree(p.worktreeId, wts)
    if (!wt) return 0
    return rankById.get(wt.id) ?? wts.length
  }

  return panels.slice().sort((a, b) => {
    const wa = rankOf(a)
    const wb = rankOf(b)
    if (wa !== wb) return wa - wb
    const ta = TYPE_ORDER[a.type] ?? 99
    const tb = TYPE_ORDER[b.type] ?? 99
    if (ta !== tb) return ta - tb
    return (a.title || '').localeCompare(b.title || '')
  })
}
