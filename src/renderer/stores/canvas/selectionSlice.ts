// =============================================================================
// Selection slice — node selection, bulk delete, and the transient snap-guide
// overlay state.
// =============================================================================

import { collectPanelIds } from '../../../shared/collectPanelIds'
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

    async deleteSelection() {
      const selectedNodeIds = [...get().selection]
      if (selectedNodeIds.length === 0) return

      // A selected node can host a mini-dock, so gather every panel before
      // beginning any close. Each panel then goes through the same confirmation
      // and lifecycle path as a normal panel close.
      const panelIds = new Set<string>()
      const panelIdsByNode = new Map<string, string[]>()
      for (const nodeId of selectedNodeIds) {
        const node = get().nodes[nodeId]
        if (!node) continue
        const nodePanelIds = new Set<string>()
        collectPanelIds(node.dockLayout, nodePanelIds)
        panelIdsByNode.set(nodeId, [...nodePanelIds])
        for (const panelId of nodePanelIds) panelIds.add(panelId)
      }

      try {
        const [{ useAppStore }, { closePanelWithConfirm }] = await Promise.all([
          import('../appStore'),
          import('../../lib/closePanelWithConfirm'),
        ])
        const workspaceId = useAppStore.getState().selectedWorkspaceId
        const closedPanelIds = new Set<string>()

        const removeClosedNodes = () => {
          const nodeIdsToRemove = selectedNodeIds.filter((nodeId) => {
            const nodePanelIds = panelIdsByNode.get(nodeId)
            return nodePanelIds !== undefined && nodePanelIds.every((id) => closedPanelIds.has(id))
          })
          if (nodeIdsToRemove.length === 0) return

          const state = get()
          state.pushHistory()
          for (const nodeId of nodeIdsToRemove) state.removeNode(nodeId)
          set((current) => ({
            selection: current.selection.filter((nodeId) => !nodeIdsToRemove.includes(nodeId)),
            selectionActive: false,
          }))
        }

        for (const panelId of panelIds) {
          if (!(await closePanelWithConfirm(workspaceId, panelId))) {
            removeClosedNodes()
            return
          }
          closedPanelIds.add(panelId)
        }

        removeClosedNodes()
      } catch {
        // Closing is user-initiated; an unavailable confirmation path must not
        // remove the selected nodes behind the user's back.
      }
    },
  }
}
