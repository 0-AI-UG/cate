// Which nodes of this canvas belong to which worktree, and in what color: the
// one source the territory layer and the focus lens read.
//
// Membership is a tag, never geometry: a node's worktree is whatever its active
// tab is tagged with (published into the view's `nodeActiveWorktreeId` by the
// node). Positions are not read here; the territory reads live geometry in its
// rAF loop, so dragging a panel never re-renders this hook.

import { useEffect, useMemo, useState } from 'react'
import { useDocument } from '@client/document/ui'
import { getActiveTheme, subscribeTheme } from '@kernel/ui'
import type { WorkspaceDocument } from '@workspace/document/contract'
import { shallowArrayEqual, useCanvasView } from '../context'
import { worktreeColor } from './worktreeColor'

export interface WorktreeGroup {
  worktreeId: string
  color: string
  nodeIds: string[]
}

export interface WorktreeMembership {
  /** One entry per worktree with at least one node on this canvas. */
  groups: WorktreeGroup[]
  /** worktreeId to resolved color, for every ready worktree. */
  colorById: Record<string, string>
}

const EMPTY: WorktreeMembership = { groups: [], colorById: {} }
const selectWorktrees = (d: WorkspaceDocument) => d.worktrees

export function useWorktreeMembership(workspaceId: string): WorktreeMembership {
  const worktrees = useDocument(workspaceId, selectWorktrees)
  const [theme, setTheme] = useState(getActiveTheme)
  useEffect(() => subscribeTheme(setTheme), [])
  // Identity changes only when a node publishes or clears its worktree.
  const nodeActive = useCanvasView((s) => s.nodeActiveWorktreeId)
  // Keys only: equal unless the node set changes, so geometry never re-renders.
  const nodeIds = useCanvasView((s) => Object.keys(s.nodes), shallowArrayEqual)

  return useMemo(() => {
    // A worktree still being created or removed is not a parallel branch yet
    // and must not count toward the 2+ gate.
    const live = Object.values(worktrees).filter((w) => w.status === 'ready')
    if (live.length < 2) return EMPTY

    const colorById: Record<string, string> = {}
    for (const w of live) if (w.color) colorById[w.id] = worktreeColor(w.color, theme)

    const present = new Set(nodeIds)
    const byWt = new Map<string, string[]>()
    for (const [nodeId, wtId] of Object.entries(nodeActive)) {
      if (!wtId || !colorById[wtId] || !present.has(nodeId)) continue
      const ids = byWt.get(wtId)
      if (ids) ids.push(nodeId)
      else byWt.set(wtId, [nodeId])
    }
    const groups: WorktreeGroup[] = []
    for (const [worktreeId, ids] of byWt) groups.push({ worktreeId, color: colorById[worktreeId], nodeIds: ids })
    return { groups, colorById }
  }, [worktrees, theme, nodeActive, nodeIds])
}
