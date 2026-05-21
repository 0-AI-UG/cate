// =============================================================================
// drag/selectors — pure derivations over DragState. Single source of truth for
// answering "what role does a given node id play in the current drag?".
//
// Two roles exist:
//   - 'whole-node': the entire node is being dragged (canvas-node spec, or a
//     single-tab detach that re-dispatches as canvas-node). The host node DOM
//     must be hidden — the DragOverlay ghost takes its place.
//   - 'tab':        a tab is being detached from a multi-panel node. The host
//     node stays visible and interactive; only the tab pill is hidden.
// =============================================================================

import type { DragState } from './types'

export type DragSourceRole = 'whole-node' | 'tab' | null

/** Returns the role this nodeId plays in the current drag, or null. */
export function selectDragSourceRole(state: DragState, nodeId: string): DragSourceRole {
  if (!state.isDragging || !state.source) return null
  const origin = state.source.origin
  if (origin.kind === 'canvas-node') {
    return origin.nodeId === nodeId ? 'whole-node' : null
  }
  if (origin.kind === 'dock-tab') {
    if (origin.sourceNodeId && origin.sourceNodeId === nodeId) return 'tab'
    return null
  }
  return null
}

/** Per-tab variant: is THIS panelId the tab currently being detached? */
export function selectDragSourceRoleForTab(
  state: DragState,
  panelId: string,
): 'tab' | null {
  if (!state.isDragging || !state.source) return null
  const src = state.source
  if (src.origin.kind === 'dock-tab' && src.panelId === panelId) return 'tab'
  // A canvas-node drag of a single-panel node also "hides" the source — but
  // the whole node is hidden by useDragSourceVisibility(nodeId), which covers
  // the tab too. Don't return 'tab' here for that case.
  return null
}
