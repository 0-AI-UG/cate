// Which role a node or tab plays in the current drag. A whole-node drag
// hides the node (the ghost takes its place); a tab dragged out of a node
// hides only the tab.

import { useStoreWithEqualityFn } from 'zustand/traditional'
import { shallow } from 'zustand/shallow'
import { useDragStore } from './store'
import type { DragState } from './types'

export type DragSourceRole = 'whole-node' | 'tab' | null

/** Returns the role this nodeId plays in the current drag, or null. */
export function selectDragSourceRole(state: DragState, nodeId: string): DragSourceRole {
  if (!state.isDragging || !state.source) return null
  const origin = state.source.origin
  if (origin.kind === 'canvas-node') {
    if (origin.nodeId === nodeId) return 'whole-node'
    // Group drag: the other selected members are dragged too, hide each so the
    // DragOverlay's per-member ghost takes its place (mirrors the anchor node).
    if (origin.members?.some((m) => m.nodeId === nodeId)) return 'whole-node'
    return null
  }
  if (origin.kind === 'dock-tab') {
    if ('nodeId' in origin.dock && origin.dock.nodeId === nodeId) return 'tab'
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
  // A canvas-node drag of a single-panel node also "hides" the source, but
  // the whole node is hidden by useDragSourceVisibility(nodeId), which covers
  // the tab too. Don't return 'tab' here for that case.
  return null
}

export interface DragSourceVisibility {
  hidden: boolean
  role: DragSourceRole
}

/** Visibility for a canvas-node id. `hidden` is true only for whole-node
 *  drags, tab-role does NOT hide the host node (the tab itself is hidden
 *  separately by DockTabStack via useTabSourceVisibility). Also stays hidden
 *  while a detach commit for this node is in flight (drag state already
 *  reset, node not yet removed) so it doesn't flash at its pre-drag spot. */
export function useDragSourceVisibility(nodeId: string): DragSourceVisibility {
  return useStoreWithEqualityFn(
    useDragStore,
    (s) => {
      const role = selectDragSourceRole(s, nodeId)
      const pending = s.pendingDetach.some((p) => p.nodeId === nodeId)
      return { hidden: role === 'whole-node' || pending, role }
    },
    shallow,
  )
}

/** Visibility for an individual dock tab. `hidden` is true while THIS panel
 *  is the dock-tab source in flight, or while its detach commit is pending
 *  (nodeId === null distinguishes dock-tab sources, whole-node pending
 *  detaches hide the host node instead, which covers the tab). */
export function useTabSourceVisibility(panelId: string): {
  hidden: boolean
  role: 'tab' | null
} {
  return useStoreWithEqualityFn(
    useDragStore,
    (s) => {
      const role = selectDragSourceRoleForTab(s, panelId)
      const pending = s.pendingDetach.some((p) => p.panelId === panelId && p.nodeId === null)
      return { hidden: role === 'tab' || pending, role }
    },
    shallow,
  )
}
