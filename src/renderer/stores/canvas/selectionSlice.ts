// =============================================================================
// Selection slice — node selection, bulk delete, and the transient snap-guide
// overlay state.
// =============================================================================

import { collectPanelIds } from '../../lib/canvas/collectPanelIds'
import type { CanvasGet, CanvasSet, CanvasStoreActions } from './storeTypes'
import { withLead } from './selectionModel'

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

    // Pure selection never activates: the result renders as selection rings
    // with no active lead, so a marquee/selectAll/toggle can't leave a node
    // looking active (halo) while sitting outside the moved set.
    selectNodes(ids, additive) {
      set((state) => {
        if (additive) {
          let next = state.selection
          for (const id of ids) next = withLead(next, id)
          return { selection: next, selectionActive: false }
        }
        // Dedupe while preserving the given order.
        return { selection: [...new Set(ids)], selectionActive: false }
      })
    },

    clearSelection() {
      set({ selection: [], selectionActive: false })
    },

    selectAll() {
      set((state) => ({
        selection: Object.keys(state.nodes),
        selectionActive: false,
      }))
    },

    toggleNodeSelection(id) {
      set((state) => {
        const next = state.selection.includes(id)
          ? state.selection.filter((x) => x !== id)
          : [...state.selection, id]
        return { selection: next, selectionActive: false }
      })
    },

    deleteSelection() {
      const state = get()
      if (state.selection.length === 0) return
      state.pushHistory()

      // Route panel-backed nodes through the real close flow so PTYs/agents are
      // disposed and the workspace panel records are removed — bare removeNode only
      // drops the canvas node, leaving the underlying panels running invisibly.
      // Collect the panel ids synchronously (before removeNode runs), then close
      // them via the appStore (imported lazily to avoid pulling the panel/terminal
      // module graph into this slice's import cycle).
      const panelIdsToClose: string[] = []
      for (const nodeId of state.selection) {
        const node = get().nodes[nodeId]
        if (!node) continue
        if (node.dockLayout) panelIdsToClose.push(...collectPanelIds(node.dockLayout))
        else if (node.panelId) panelIdsToClose.push(node.panelId)
        get().removeNode(nodeId)
      }

      set({ selection: [], selectionActive: false })

      if (panelIdsToClose.length > 0) {
        void import('../appStore').then(({ useAppStore }) => {
          const wsId = useAppStore.getState().selectedWorkspaceId
          const closePanel = useAppStore.getState().closePanel
          for (const panelId of panelIdsToClose) closePanel(wsId, panelId)
        })
      }
    },
  }
}
