// =============================================================================
// Selection slice — node/region selection (with region->children cascade),
// bulk delete, and the transient snap-guide overlay state.
// =============================================================================

import type { CanvasGet, CanvasSet, CanvasStoreActions } from './storeTypes'

type SelectionActions = Pick<
  CanvasStoreActions,
  | 'setSnapGuides'
  | 'clearSnapGuides'
  | 'selectNodes'
  | 'selectRegions'
  | 'clearSelection'
  | 'selectAll'
  | 'toggleNodeSelection'
  | 'toggleRegionSelection'
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

    selectRegions(ids, additive) {
      set((state) => {
        const nextRegions = additive ? new Set(state.selectedRegionIds) : new Set<string>()
        const nextNodes = additive ? new Set(state.selectedNodeIds) : new Set<string>()
        for (const id of ids) {
          nextRegions.add(id)
          // Cascade: select all contained nodes
          for (const node of Object.values(state.nodes)) {
            if (node.regionId === id) nextNodes.add(node.id)
          }
        }
        return { selectedRegionIds: nextRegions, selectedNodeIds: nextNodes }
      })
    },

    clearSelection() {
      set({ selectedNodeIds: new Set<string>(), selectedRegionIds: new Set<string>() })
    },

    selectAll() {
      set((state) => ({
        selectedNodeIds: new Set(Object.keys(state.nodes)),
        selectedRegionIds: new Set(Object.keys(state.regions)),
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

    toggleRegionSelection(id) {
      set((state) => {
        const nextRegions = new Set(state.selectedRegionIds)
        const nextNodes = new Set(state.selectedNodeIds)
        if (nextRegions.has(id)) {
          nextRegions.delete(id)
          // Also deselect contained nodes
          for (const node of Object.values(state.nodes)) {
            if (node.regionId === id) nextNodes.delete(node.id)
          }
        } else {
          nextRegions.add(id)
          // Also select contained nodes
          for (const node of Object.values(state.nodes)) {
            if (node.regionId === id) nextNodes.add(node.id)
          }
        }
        return { selectedRegionIds: nextRegions, selectedNodeIds: nextNodes }
      })
    },

    deleteSelection(includeRegionContents) {
      const state = get()
      if (state.selectedNodeIds.size > 0 || state.selectedRegionIds.size > 0) {
        state.pushHistory()
      }

      // Collect node IDs to remove (selected nodes + region contents if requested).
      // When NOT including region contents, exclude any selected node that lives
      // inside a selected region — selectRegions() cascades into the children, so
      // without this exclusion the "region only" path would still delete them.
      const nodeIdsToRemove = new Set(state.selectedNodeIds)
      if (!includeRegionContents && state.selectedRegionIds.size > 0) {
        for (const node of Object.values(state.nodes)) {
          if (node.regionId && state.selectedRegionIds.has(node.regionId)) {
            nodeIdsToRemove.delete(node.id)
          }
        }
      }
      for (const regionId of state.selectedRegionIds) {
        if (includeRegionContents) {
          for (const node of Object.values(state.nodes)) {
            if (node.regionId === regionId) nodeIdsToRemove.add(node.id)
          }
        }
      }

      // Trigger exit animation for each node (cleanup happens in component lifecycle)
      for (const nodeId of nodeIdsToRemove) {
        get().removeNode(nodeId)
      }

      // Handle regions: detach children of non-content-deleted regions, then remove
      set((s) => {
        const updatedNodes = { ...s.nodes }
        const updatedRegions = { ...s.regions }

        for (const regionId of state.selectedRegionIds) {
          if (!includeRegionContents) {
            // Detach children that weren't deleted
            for (const nodeId of Object.keys(updatedNodes)) {
              if (updatedNodes[nodeId].regionId === regionId) {
                updatedNodes[nodeId] = { ...updatedNodes[nodeId], regionId: undefined }
              }
            }
          }
          delete updatedRegions[regionId]
        }

        return {
          nodes: updatedNodes,
          regions: updatedRegions,
          selectedNodeIds: new Set<string>(),
          selectedRegionIds: new Set<string>(),
        }
      })
    },
  }
}
