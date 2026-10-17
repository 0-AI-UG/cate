// The drag state views subscribe to. Only the runtime's steps write it
// (`applyDragState`), for local and relayed drags alike.

import { create } from 'zustand'
import type { PanelId } from '@workspace/document/contract'
import { INITIAL_DRAG_STATE, type DragState } from './types'

/** A source whose detach is still settling: the drag state is already reset
 *  but the document has not moved the panel yet. Views keep it hidden so it
 *  does not flash at its old spot. `nodeId` is null for a dock tab. */
export interface PendingDetach {
  panelId: PanelId
  nodeId: string | null
}

export interface DragActions {
  applyDragState(next: DragState): void
  beginPendingDetach(panelId: PanelId, nodeId: string | null): void
  endPendingDetach(panelId: PanelId): void
}

export const useDragStore = create<DragState & { pendingDetach: PendingDetach[] } & DragActions>((set) => ({
  ...INITIAL_DRAG_STATE,
  pendingDetach: [],
  applyDragState(next) {
    set(next)
  },
  beginPendingDetach(panelId, nodeId) {
    set((s) => ({ pendingDetach: [...s.pendingDetach, { panelId, nodeId }] }))
  },
  endPendingDetach(panelId) {
    set((s) => ({ pendingDetach: s.pendingDetach.filter((p) => p.panelId !== panelId) }))
  },
}))
