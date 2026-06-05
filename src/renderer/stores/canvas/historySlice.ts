// =============================================================================
// History slice — undo/redo snapshots of {nodes, regions, focusedNodeId}.
// =============================================================================

import type { CanvasGet, CanvasSet, CanvasHistoryEntry, CanvasStoreActions } from './storeTypes'

type HistoryActions = Pick<CanvasStoreActions, 'pushHistory' | 'undo' | 'redo' | 'clearHistory'>

export function createHistorySlice(set: CanvasSet, get: CanvasGet): HistoryActions {
  return {
    pushHistory() {
      const state = get()
      const entry: CanvasHistoryEntry = {
        nodes: state.nodes,
        regions: state.regions,
        focusedNodeId: state.focusedNodeId,
      }
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
      const current: CanvasHistoryEntry = {
        nodes: state.nodes,
        regions: state.regions,
        focusedNodeId: state.focusedNodeId,
      }
      set({
        nodes: prev.nodes,
        regions: prev.regions,
        focusedNodeId: prev.focusedNodeId,
        history: state.history.slice(0, -1),
        future: [...state.future, current],
      })
    },

    redo() {
      const state = get()
      if (state.future.length === 0) return
      const next = state.future[state.future.length - 1]
      const current: CanvasHistoryEntry = {
        nodes: state.nodes,
        regions: state.regions,
        focusedNodeId: state.focusedNodeId,
      }
      set({
        nodes: next.nodes,
        regions: next.regions,
        focusedNodeId: next.focusedNodeId,
        history: [...state.history, current],
        future: state.future.slice(0, -1),
      })
    },

    clearHistory() {
      set({ history: [], future: [] })
    },
  }
}
