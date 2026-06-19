// =============================================================================
// useWorktreeMembership — derives, from the current canvas + workspace, which
// nodes belong to which worktree and in what color. This is the single source
// the sludge layer and focus lens read from.
//
// Membership is a TAG, never geometry: a node's worktree is whatever its active
// tab is tagged with (published into canvasStore.nodeActiveWorktreeId by
// CanvasNode). This hook intentionally does NOT depend on node positions/sizes —
// the sludge reads live geometry imperatively in its rAF loop, so dragging a
// panel never re-renders React here.
// =============================================================================

import { useMemo } from 'react'
import { useCanvasStoreContext, shallow } from '../../stores/CanvasStoreContext'
import { useAppStore } from '../../stores/appStore'
import { useWorktrees } from '../../stores/useWorktrees'

export interface WorktreeGroup {
  worktreeId: string
  color: string
  nodeIds: string[]
}

export interface WorktreeMembership {
  /** One entry per worktree that has at least one node on this canvas. */
  groups: WorktreeGroup[]
  /** worktreeId → color, for every worktree in the workspace. */
  colorById: Record<string, string>
}

const EMPTY: WorktreeMembership = { groups: [], colorById: {} }

/**
 * Reads the SAME reconciled worktree list as the WorktreePill and toolbar menu
 * (live `git worktree list` joined with persisted UI metadata, orphans dropped),
 * so the terrace can never disagree with them: a single-branch flow shows no
 * sludge at all. Gating on the raw persisted `appStore.worktrees` instead let a
 * stale/orphan metadata record paint a territory the other surfaces had hidden.
 */
export function useWorktreeMembership(): WorktreeMembership {
  const workspaceId = useAppStore((s) => s.selectedWorkspaceId ?? '')
  const rootPath = useAppStore(
    (s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId)?.rootPath ?? '',
  )
  const joined = useWorktrees(rootPath, workspaceId)
  // Object identity changes only when a node publishes/clears its worktree
  // (tab switch, create, close) — not on drag/resize.
  const nodeActive = useCanvasStoreContext((s) => s.nodeActiveWorktreeId)
  // Keys only — new array each store change but shallow-equal unless the set of
  // nodes changes, so geometry updates don't re-render.
  const nodeIds = useCanvasStoreContext((s) => Object.keys(s.nodes), shallow)

  return useMemo(() => {
    // Live checkouts only — an orphan (metadata without a worktree on disk) is a
    // ghost, not a parallel branch, and must not count toward the 2+ gate.
    const live = joined.filter((w) => !w.isOrphan)
    if (live.length < 2) return EMPTY

    const colorById: Record<string, string> = {}
    for (const w of live) if (w.color) colorById[w.id] = w.color

    const present = new Set(nodeIds)
    const byWt = new Map<string, string[]>()
    for (const [nodeId, wtId] of Object.entries(nodeActive)) {
      if (!wtId || !colorById[wtId] || !present.has(nodeId)) continue
      const arr = byWt.get(wtId)
      if (arr) arr.push(nodeId)
      else byWt.set(wtId, [nodeId])
    }

    const groups: WorktreeGroup[] = []
    for (const [worktreeId, ids] of byWt) {
      groups.push({ worktreeId, color: colorById[worktreeId], nodeIds: ids })
    }
    return { groups, colorById }
  }, [joined, nodeActive, nodeIds])
}
