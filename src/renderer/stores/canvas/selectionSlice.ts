// =============================================================================
// Selection slice — node selection, bulk delete, and the transient snap-guide
// overlay state.
// =============================================================================

import type { CanvasGet, CanvasSet, CanvasStoreActions } from './storeTypes'

type SelectionActions = Pick<
  CanvasStoreActions,
  | 'setSnapGuides'
  | 'clearSnapGuides'
  | 'selectNodes'
  | 'clearSelection'
  | 'selectAll'
  | 'toggleNodeSelection'
  | 'deleteSelection'
>

export function createSelectionSlice(set: CanvasSet, get: CanvasGet): SelectionActions {
  return {
    setSnapGuides(guides) {
      set({ snapGuides: guides })
    },

    clearSnapGuides() {
      set({ snapGuides: { lines: [] } })
    },

    selectNodes(ids, additive) {
      set((state) => {
        const next = additive ? new Set(state.selectedNodeIds) : new Set<string>()
        for (const id of ids) next.add(id)
        return { selectedNodeIds: next }
      })
    },

    clearSelection() {
      set({ selectedNodeIds: new Set<string>() })
    },

    selectAll() {
      set((state) => ({
        selectedNodeIds: new Set(Object.keys(state.nodes)),
      }))
    },

    toggleNodeSelection(id) {
      set((state) => {
        const next = new Set(state.selectedNodeIds)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return { selectedNodeIds: next }
      })
    },

    deleteSelection() {
      const state = get()
      if (state.selectedNodeIds.size === 0) return
      state.pushHistory()

      // Trigger exit animation for each node (cleanup happens in component lifecycle)
      for (const nodeId of state.selectedNodeIds) {
        get().removeNode(nodeId)
      }

      set({ selectedNodeIds: new Set<string>() })
    },
  }
}
