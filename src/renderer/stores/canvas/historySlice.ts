// =============================================================================
// History slice — undo/redo snapshots of {nodes, selection, selectionActive}.
// =============================================================================

import type { CanvasGet, CanvasSet, CanvasHistoryEntry, CanvasStoreActions } from './storeTypes'

type HistoryActions = Pick<CanvasStoreActions, 'pushHistory' | 'undo' | 'redo' | 'clearHistory'>

// Build a snapshot of the current store state. The selection array is CLONED —
// the live array is replaced (not mutated) later, but cloning keeps history
// entries defensively independent of any future in-place edit.
function snapshot(state: {
  nodes: CanvasHistoryEntry['nodes']
  selection: CanvasHistoryEntry['selection']
  selectionActive: boolean
}): CanvasHistoryEntry {
  return {
    nodes: state.nodes,
    selection: [...state.selection],
    selectionActive: state.selectionActive,
  }
}

// Restore an entry, filtering its selection to ids that still exist in its own
// nodes so no dangling ids (e.g. nodes deleted in the undone step) survive.
function restore(entry: CanvasHistoryEntry) {
  return {
    nodes: entry.nodes,
    selection: entry.selection.filter((id) => entry.nodes[id]),
    selectionActive: entry.selectionActive,
  }
}

export function createHistorySlice(set: CanvasSet, get: CanvasGet): HistoryActions {
  return {
    pushHistory() {
      const state = get()
      const entry = snapshot(state)
      const MAX = 100
      const history = state.history.length >= MAX
        ? [...state.history.slice(1), entry]
        : [...state.history, entry]
      set({ history, future: [] })
    },

    undo() {
      const state = get()
      if (state.history.length === 0) return
      const prev = state.history[state.history.length - 1]
      const current = snapshot(state)
      set({
        ...restore(prev),
        history: state.history.slice(0, -1),
        future: [...state.future, current],
      })
    },

    redo() {
      const state = get()
      if (state.future.length === 0) return
      const next = state.future[state.future.length - 1]
      const current = snapshot(state)
      set({
        ...restore(next),
        history: [...state.history, current],
        future: state.future.slice(0, -1),
      })
    },

    clearHistory() {
      set({ history: [], future: [] })
    },
  }
}
