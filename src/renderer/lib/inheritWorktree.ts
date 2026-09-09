// =============================================================================
// inheritWorktree — when a new terminal / agent is created on a canvas via a
// generic action (⌘T, ⇧⌘A, the toolbar's terminal/agent buttons), it should open
// in the SAME worktree as the panel the user currently has selected on that
// canvas. File-backed and review panels derive this from the path they operate
// on; terminals and agents carry an explicit checkout context.
//
// The worktree-aware create paths that already target a specific worktree (the
// worktree drop-up, folder drops, per-worktree context menus) pass their own
// cwd/worktreeId and don't go through here.
// =============================================================================

import type { PanelState } from '../../shared/types'
import type { WorktreeMeta } from '../../shared/types'
import type { CanvasStoreState } from '../stores/canvas/storeTypes'
import { focusedNodeId } from '../stores/canvas/selectionModel'
import { activeDockPanelId } from '../../shared/collectPanelIds'
import { worktreeForPanel } from './worktreeContext'

export interface InheritedWorktree {
  /** Explicit working directory of the selected terminal (a dropped folder or a
   *  non-primary worktree checkout). Undefined for the workspace root. */
  cwd?: string
  /** Worktree the selected panel is bound to, authoritative over cwd. */
  worktreeId?: string
}

/** The worktree/cwd a newly created terminal or agent should inherit from the
 *  canvas's currently selected node — but only when that node is itself a
 *  worktree-bearing panel. Returns empty ({}) when nothing
 *  worktree-bearing is selected, so callers fall back to their default placement.
 */
export function inheritedWorktreeFromSelection(
  canvasState: Pick<CanvasStoreState, 'selection' | 'selectionActive' | 'nodes'>,
  panels: Record<string, PanelState> | undefined,
  worktrees: readonly WorktreeMeta[] = [],
): InheritedWorktree {
  const nodeId = focusedNodeId(canvasState)
  if (!nodeId || !panels) return {}
  const panelId = activeDockPanelId(canvasState.nodes[nodeId]?.dockLayout)
  const panel = panelId ? panels[panelId] : undefined
  return inheritedWorktreeFromPanel(panel, worktrees)
}

/** Shared creation context for canvas selection and focused dock leaves. */
export function inheritedWorktreeFromPanel(
  panel: PanelState | undefined,
  worktrees: readonly WorktreeMeta[] = [],
): InheritedWorktree {
  if (!panel) return {}
  const worktree = worktreeForPanel(panel, worktrees)
  if (panel.type === 'terminal' || panel.type === 'agent') {
    return { cwd: panel.cwd ?? worktree?.path, worktreeId: panel.worktreeId ?? worktree?.id }
  }
  return worktree ? { cwd: worktree.path, worktreeId: worktree.id } : {}
}
