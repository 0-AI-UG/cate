// =============================================================================
// inheritWorktree — when a new terminal / agent is created on a canvas via a
// generic action (⌘T, ⇧⌘A, the toolbar's terminal/agent buttons), it should open
// in the SAME worktree as the terminal/agent the user currently has selected on
// that canvas. This keeps a "new terminal" fired from inside a worktree's
// terminal in that worktree instead of snapping back to the workspace root.
//
// The worktree-aware create paths that already target a specific worktree (the
// worktree drop-up, folder drops, per-worktree context menus) pass their own
// cwd/worktreeId and don't go through here.
// =============================================================================

import type { PanelState } from '../../shared/types'
import { isWorktreePanelType } from '../../shared/panels'
import type { CanvasStoreState } from '../stores/canvas/storeTypes'
import { focusedNodeId } from '../stores/canvas/selectionModel'
import { activeDockPanelId } from '../../shared/collectPanelIds'

export interface InheritedWorktree {
  /** Explicit working directory of the selected terminal (a dropped folder or a
   *  non-primary worktree checkout). Undefined for the workspace root. */
  cwd?: string
  /** Worktree the selected panel is bound to, authoritative over cwd. */
  worktreeId?: string
}

/** The worktree/cwd a newly created terminal or agent should inherit from the
 *  canvas's currently selected node — but only when that node is itself a
 *  worktree-bearing panel (a terminal or agent). Returns empty ({}) when nothing
 *  worktree-bearing is selected, so callers fall back to their default placement.
 */
export function inheritedWorktreeFromSelection(
  canvasState: Pick<CanvasStoreState, 'selection' | 'selectionActive' | 'nodes'>,
  panels: Record<string, PanelState> | undefined,
): InheritedWorktree {
  const nodeId = focusedNodeId(canvasState)
  if (!nodeId || !panels) return {}
  const panelId = activeDockPanelId(canvasState.nodes[nodeId]?.dockLayout)
  const panel = panelId ? panels[panelId] : undefined
  if (!panel || !isWorktreePanelType(panel.type)) return {}
  return { cwd: panel.cwd, worktreeId: panel.worktreeId }
}
