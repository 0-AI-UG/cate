// =============================================================================
// drag/store — thin zustand wrapper around DragState. The runtime owns the
// state transitions; this module just exposes a useStore hook so React
// components can subscribe to slices of the current drag snapshot.
//
// Both local (`useDragOp`) and remote (`crossWindow.ts`) flows write into the
// store via `applyDragState(next)` — the only setter. There is no separate
// "patch the store" API: every transition goes through the runtime reducer.
// =============================================================================

import { create } from 'zustand'
import { INITIAL_DRAG_STATE, type DragState } from './types'

export type { DragSource, DropTarget, DragState } from './types'

export interface DragActions {
  /** Replace the state slice in one shot — used by the runtime dispatcher. */
  applyDragState(next: DragState): void
}

export const useDragStore = create<DragState & DragActions>((set) => ({
  ...INITIAL_DRAG_STATE,

  applyDragState(next) {
    set(next)
  },
}))
