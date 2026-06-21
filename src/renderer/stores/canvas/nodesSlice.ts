// =============================================================================
// Nodes slice — node lifecycle (create/remove/move/resize), focus, z-order,
// maximize, per-node dock layout, and node queries.
// =============================================================================

import type { CanvasNodeState } from '../../../shared/types'
import { PANEL_DEFAULT_SIZES } from '../../../shared/types'
import { findFreePosition } from '../../canvas/placement'
import type { CanvasGet, CanvasSet, CanvasStoreActions, CanvasStoreState } from './storeTypes'
import { generateId, IS_E2E } from './helpers'
import { focusedNodeId } from './selectionModel'

type NodesActions = Pick<
  CanvasStoreActions,
  | 'addNode'
  | 'removeNode'
  | 'finalizeRemoveNode'
  | 'setNodeAnimationState'
  | 'moveNode'
  | 'resizeNode'
  | 'focusNode'
  | 'unfocus'
  | 'toggleMaximize'
  | 'focusAndCenter'
  | 'moveToFront'
  | 'moveToBack'
  | 'togglePin'
  | 'setNodeActiveWorktree'
  | 'setNodeDockLayout'
  | 'nodeForPanel'
  | 'sortedNodesByCreationOrder'
  | 'nextNode'
  | 'previousNode'
>

export function createNodesSlice(set: CanvasSet, get: CanvasGet): NodesActions {
  return {
    addNode(panelId, panelType, position, size) {
      // Canvas-on-canvas is unsupported and produces broken interaction (nested
      // zoom, ambiguous drag targets, duplicate stores keyed by the same id).
      // Refuse at the data layer regardless of which UI path tried it.
      if (panelType === 'canvas') {
        return ''
      }
      get().pushHistory()
      const state = get()
      const defaultSize = size ?? PANEL_DEFAULT_SIZES[panelType]
      // Dedupe on panelId: reposition + resize + focus the existing node.
      const existing = Object.values(state.nodes).find((n) => n.panelId === panelId)
      if (existing) {
        const { [existing.id]: _omit, ...otherNodes } = state.nodes
        const nextOrigin = findFreePosition(otherNodes, existing.id, defaultSize, position)
        set({
          nodes: {
            ...state.nodes,
            [existing.id]: {
              ...existing,
              origin: nextOrigin,
              size: defaultSize,
              zOrder: state.nextZOrder,
            },
          },
          nextZOrder: state.nextZOrder + 1,
          selection: [existing.id],
          selectionActive: true,
        })
        return existing.id
      }
      const nodeId = generateId()
      const origin = findFreePosition(state.nodes, focusedNodeId(state), defaultSize, position)

      const node: CanvasNodeState = {
        id: nodeId,
        panelId,
        origin,
        size: defaultSize,
        zOrder: state.nextZOrder,
        creationIndex: state.nextCreationIndex,
        animationState: IS_E2E ? 'idle' : 'entering',
        // Seed the per-node dock layout with a single tab stack containing the
        // initial panel. The CanvasNodeWrapper hydrates this into a per-node
        // DockStore on mount.
        dockLayout: {
          type: 'tabs',
          id: generateId(),
          panelIds: [panelId],
          activeIndex: 0,
        },
      }

      set({
        nodes: { ...state.nodes, [nodeId]: node },
        nextZOrder: state.nextZOrder + 1,
        nextCreationIndex: state.nextCreationIndex + 1,
      })

      return nodeId
    },

    removeNode(id) {
      if (get().nodes[id]) get().pushHistory()
      set((state) => {
        const node = state.nodes[id]
        if (!node) return state
        // Drop the node from the selection now (it's on its way out) and
        // deactivate if it was the active lead, so nothing renders a ring/halo
        // on an unmounting node.
        const wasActiveLead = focusedNodeId(state) === id
        return {
          nodes: {
            ...state.nodes,
            [id]: { ...node, animationState: 'exiting' as const },
          },
          selection: state.selection.filter((x) => x !== id),
          selectionActive: wasActiveLead ? false : state.selectionActive,
        }
      })
    },

    finalizeRemoveNode(nodeId) {
      const { [nodeId]: _, ...rest } = get().nodes
      set((state) => ({
        nodes: rest,
        // Defensive: ensure a finalized node never lingers in the selection.
        selection: state.selection.includes(nodeId)
          ? state.selection.filter((x) => x !== nodeId)
          : state.selection,
      }))
    },

    setNodeAnimationState(nodeId, state) {
      const node = get().nodes[nodeId]
      if (node) {
        set({ nodes: { ...get().nodes, [nodeId]: { ...node, animationState: state } } })
      }
    },

    moveNode(id, origin) {
      set((state) => {
        const node = state.nodes[id]
        if (!node) return state
        return {
          nodes: {
            ...state.nodes,
            [id]: { ...node, origin },
          },
        }
      })
    },

    resizeNode(id, size, origin) {
      set((state) => {
        const node = state.nodes[id]
        if (!node) return state
        return {
          nodes: {
            ...state.nodes,
            [id]: {
              ...node,
              size,
              ...(origin != null ? { origin } : {}),
            },
          },
        }
      })
    },

    focusNode(id) {
      set((state) => {
        const node = state.nodes[id]
        if (!node) return state
        return {
          nodes: {
            ...state.nodes,
            [id]: { ...node, zOrder: state.nextZOrder },
          },
          nextZOrder: state.nextZOrder + 1,
          // Activating a node collapses the selection to just it and makes it
          // the active lead — so the active panel is always part of (and the
          // only member of) the selection. Mirrors a plain click.
          selection: [id],
          selectionActive: true,
          focusEpoch: state.focusEpoch + 1,
          // An explicit focus (click, switcher, auto-focus) ends keyboard-nav mode.
          suppressAutoFocus: false,
        }
      })
    },

    unfocus() {
      // Deactivate the lead but keep the selection (rings remain), matching the
      // old unfocus() which cleared focus without touching the selection.
      set({ selectionActive: false })
    },

    toggleMaximize(id, viewportSize) {
      const state = get()
      const node = state.nodes[id]
      if (!node) return

      const isMaximized = node.preMaximizeOrigin != null

      let updated: CanvasNodeState
      if (isMaximized) {
        // Restore pre-maximize geometry
        updated = {
          ...node,
          origin: node.preMaximizeOrigin!,
          size: node.preMaximizeSize!,
          preMaximizeOrigin: undefined,
          preMaximizeSize: undefined,
        }
      } else {
        // Save current geometry and maximize to fill visible canvas area
        const cs = state.containerSize
        const topLeft = get().viewToCanvas({ x: 0, y: 0 })
        const bottomRight = get().viewToCanvas({
          x: cs.width || viewportSize.width,
          y: cs.height || viewportSize.height,
        })
        const padding = 20 / state.zoomLevel

        updated = {
          ...node,
          preMaximizeOrigin: { ...node.origin },
          preMaximizeSize: { ...node.size },
          origin: {
            x: topLeft.x + padding,
            y: topLeft.y + padding,
          },
          size: {
            width: (bottomRight.x - topLeft.x) - padding * 2,
            height: (bottomRight.y - topLeft.y) - padding * 2,
          },
        }
      }

      // Focus the node as well (bump zOrder)
      updated = { ...updated, zOrder: state.nextZOrder }

      set({
        nodes: { ...state.nodes, [id]: updated },
        nextZOrder: state.nextZOrder + 1,
        selection: [id],
        selectionActive: true,
        focusEpoch: state.focusEpoch + 1,
      })
    },

    nodeForPanel(panelId) {
      const { nodes } = get()
      const found = Object.values(nodes).find((n) => n.panelId === panelId)
      return found?.id ?? null
    },

    sortedNodesByCreationOrder() {
      const { nodes } = get()
      return Object.values(nodes).sort((a, b) => a.creationIndex - b.creationIndex)
    },

    nextNode() {
      const focused = focusedNodeId(get())
      const sorted = get().sortedNodesByCreationOrder()
      if (sorted.length === 0) return null
      if (!focused) return sorted[0].id
      const index = sorted.findIndex((n) => n.id === focused)
      if (index === -1) return sorted[0].id
      return sorted[(index + 1) % sorted.length].id
    },

    previousNode() {
      const focused = focusedNodeId(get())
      const sorted = get().sortedNodesByCreationOrder()
      if (sorted.length === 0) return null
      if (!focused) return sorted[sorted.length - 1].id
      const index = sorted.findIndex((n) => n.id === focused)
      if (index === -1) return sorted[sorted.length - 1].id
      return sorted[(index - 1 + sorted.length) % sorted.length].id
    },

    moveToFront(nodeId) {
      set((state) => {
        const node = state.nodes[nodeId]
        if (!node) return state
        return {
          nodes: { ...state.nodes, [nodeId]: { ...node, zOrder: state.nextZOrder } },
          nextZOrder: state.nextZOrder + 1,
        }
      })
    },

    moveToBack(nodeId) {
      set((state) => {
        const node = state.nodes[nodeId]
        if (!node) return state
        const nodeList = Object.values(state.nodes)
        const minZOrder = nodeList.reduce((min, n) => Math.min(min, n.zOrder), Infinity)
        return {
          nodes: { ...state.nodes, [nodeId]: { ...node, zOrder: minZOrder - 1 } },
        }
      })
    },

    focusAndCenter(nodeId) {
      const state = get()
      const node = state.nodes[nodeId]
      if (!node) return
      const updated = { ...node, zOrder: state.nextZOrder }
      const cs = state.containerSize
      const zoom = state.zoomLevel
      const newState: Partial<CanvasStoreState> = {
        nodes: { ...state.nodes, [nodeId]: updated },
        nextZOrder: state.nextZOrder + 1,
        selection: [nodeId],
        selectionActive: true,
        focusEpoch: state.focusEpoch + 1,
      }
      if (cs.width > 0 && cs.height > 0) {
        newState.viewportOffset = {
          x: cs.width / 2 - (node.origin.x + node.size.width / 2) * zoom,
          y: cs.height / 2 - (node.origin.y + node.size.height / 2) * zoom,
        }
      }
      set(newState)
    },

    togglePin(id) {
      set((state) => {
        const node = state.nodes[id]
        if (!node) return state
        return {
          nodes: { ...state.nodes, [id]: { ...node, isPinned: !node.isPinned } },
        }
      })
    },

    setNodeActiveWorktree(nodeId, worktreeId) {
      const cur = get().nodeActiveWorktreeId
      if (cur[nodeId] === worktreeId) return
      if (worktreeId === null && !(nodeId in cur)) return
      const next = { ...cur }
      if (worktreeId === null) delete next[nodeId]
      else next[nodeId] = worktreeId
      set({ nodeActiveWorktreeId: next })
    },

    setNodeDockLayout(nodeId, layout) {
      set((state) => {
        const node = state.nodes[nodeId]
        if (!node) return state
        return {
          nodes: {
            ...state.nodes,
            [nodeId]: { ...node, dockLayout: layout },
          },
        }
      })
    },
  }
}
