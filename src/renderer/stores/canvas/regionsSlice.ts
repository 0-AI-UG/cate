// =============================================================================
// Regions slice — region CRUD, node<->region containment, and grouping the
// current selection into a region.
// =============================================================================

import type { CanvasRegion } from '../../../shared/types'
import { REGION_FILL_COLORS } from '../../../shared/colors'
import type { CanvasGet, CanvasSet, CanvasStoreActions } from './storeTypes'
import { generateId } from './helpers'

type RegionsActions = Pick<
  CanvasStoreActions,
  | 'addRegion'
  | 'removeRegion'
  | 'moveRegion'
  | 'resizeRegion'
  | 'renameRegion'
  | 'updateRegionColor'
  | 'setRegionDefaultCwd'
  | 'setNodeRegion'
  | 'getNodesInRegion'
  | 'groupSelectedIntoRegion'
  | 'dissolveRegion'
>

export function createRegionsSlice(set: CanvasSet, get: CanvasGet): RegionsActions {
  return {
    addRegion(label, origin, size, color) {
      const id = generateId()
      const region: CanvasRegion = {
        id,
        origin,
        size,
        label,
        color: color || REGION_FILL_COLORS[0],
        zOrder: -1000,
      }
      set((state) => ({
        regions: { ...state.regions, [id]: region },
      }))
      return id
    },

    removeRegion(id) {
      set((state) => {
        const { [id]: _, ...rest } = state.regions
        return { regions: rest }
      })
    },

    moveRegion(id, origin) {
      set((state) => {
        const region = state.regions[id]
        if (!region) return state
        const dx = origin.x - region.origin.x
        const dy = origin.y - region.origin.y
        const updatedNodes = { ...state.nodes }
        for (const node of Object.values(state.nodes)) {
          if (node.regionId === id) {
            updatedNodes[node.id] = {
              ...node,
              origin: { x: node.origin.x + dx, y: node.origin.y + dy },
            }
          }
        }
        return {
          regions: { ...state.regions, [id]: { ...region, origin } },
          nodes: updatedNodes,
        }
      })
    },

    resizeRegion(id, size, origin) {
      set((state) => {
        const region = state.regions[id]
        if (!region) return state
        return {
          regions: {
            ...state.regions,
            [id]: { ...region, size, ...(origin ? { origin } : {}) },
          },
        }
      })
    },

    renameRegion(id, label) {
      set((state) => {
        const region = state.regions[id]
        if (!region) return state
        return {
          regions: { ...state.regions, [id]: { ...region, label } },
        }
      })
    },

    updateRegionColor(id, color) {
      set((state) => {
        const region = state.regions[id]
        if (!region) return state
        return {
          regions: { ...state.regions, [id]: { ...region, color } },
        }
      })
    },

    setRegionDefaultCwd(id, defaultCwd) {
      set((state) => {
        const region = state.regions[id]
        if (!region) return state
        return {
          regions: { ...state.regions, [id]: { ...region, defaultCwd } },
        }
      })
    },

    setNodeRegion(nodeId, regionId) {
      set((state) => {
        const node = state.nodes[nodeId]
        if (!node) return state
        return {
          nodes: { ...state.nodes, [nodeId]: { ...node, regionId } },
        }
      })
    },

    getNodesInRegion(regionId) {
      return Object.values(get().nodes).filter((n) => n.regionId === regionId)
    },

    groupSelectedIntoRegion() {
      const state = get()
      const selectedNodes = Object.values(state.nodes).filter((n) => state.selectedNodeIds.has(n.id))
      if (selectedNodes.length === 0) return null

      // Compute bounding box with padding
      const padding = 30
      const minX = Math.min(...selectedNodes.map((n) => n.origin.x)) - padding
      const minY = Math.min(...selectedNodes.map((n) => n.origin.y)) - padding
      const maxX = Math.max(...selectedNodes.map((n) => n.origin.x + n.size.width)) + padding
      const maxY = Math.max(...selectedNodes.map((n) => n.origin.y + n.size.height)) + padding

      const regionId = get().addRegion(
        'Region',
        { x: minX, y: minY },
        { width: maxX - minX, height: maxY - minY },
      )

      // Assign regionId to all selected nodes
      set((s) => {
        const updatedNodes = { ...s.nodes }
        for (const node of selectedNodes) {
          updatedNodes[node.id] = { ...updatedNodes[node.id], regionId }
        }
        return { nodes: updatedNodes }
      })

      return regionId
    },

    dissolveRegion(regionId) {
      set((state) => {
        // Detach all children
        const updatedNodes = { ...state.nodes }
        for (const nodeId of Object.keys(updatedNodes)) {
          if (updatedNodes[nodeId].regionId === regionId) {
            updatedNodes[nodeId] = { ...updatedNodes[nodeId], regionId: undefined }
          }
        }
        // Remove the region
        const { [regionId]: _, ...restRegions } = state.regions
        // Remove from selection
        const nextRegionIds = new Set(state.selectedRegionIds)
        nextRegionIds.delete(regionId)
        return { nodes: updatedNodes, regions: restRegions, selectedRegionIds: nextRegionIds }
      })
    },
  }
}
