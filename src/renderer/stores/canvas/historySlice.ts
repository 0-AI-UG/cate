// =============================================================================
// History slice — undo/redo snapshots of {nodes, focusedNodeId,
// selectedNodeIds}.
// =============================================================================

import type { CanvasGet, CanvasSet, CanvasHistoryEntry, CanvasStoreActions } from './storeTypes'

type HistoryActions = Pick<CanvasStoreActions, 'pushHistory' | 'undo' | 'redo' | 'clearHistory'>

// Build a snapshot of the current store state. Selection sets are CLONED — the
// live sets get mutated in place later, so storing the references would corrupt
// already-recorded history.
function snapshot(state: {
  nodes: CanvasHistoryEntry['nodes']
  focusedNodeId: CanvasHistoryEntry['focusedNodeId']
  selectedNodeIds: Set<string>
}): CanvasHistoryEntry {
  return {
    nodes: state.nodes,
    focusedNodeId: state.focusedNodeId,
    selectedNodeIds: new Set(state.selectedNodeIds),
  }
}

// Restore an entry, intersecting its selection with its own nodes so no
// dangling ids (e.g. nodes that were deleted in the undone step) survive.
function restore(entry: CanvasHistoryEntry) {
  return {
    nodes: entry.nodes,
    focusedNodeId: entry.focusedNodeId,
    selectedNodeIds: new Set([...entry.selectedNodeIds].filter((id) => entry.nodes[id])),
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
