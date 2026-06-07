// =============================================================================
// Dock Store — Zustand state for dock zone layout and panel locations.
// Manages VS Code-style dock zones (left, right, bottom) with split and tab support.
// =============================================================================

import { create } from 'zustand'
import type {
  DockZonePosition,
  DockLayoutNode,
  DockSplitNode,
  DockTabStack,
  DockZoneState,
  WindowDockState,
  PanelLocation,
  DockDropTarget,
  Point,
} from '../../shared/types'
import { SIDE_ZONES, ALL_ZONES } from '../../shared/types'
import { findTabStack, findZoneForStack, findStackContainingPanel } from './dockTreeUtils'
import { clearActivePanelIfMatches } from '../lib/activePanel'
import { generateId } from './canvas/helpers'

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_SIDE_ZONE_SIZE = 260
const DEFAULT_BOTTOM_ZONE_SIZE = 240
const MIN_ZONE_SIZE = 120

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function createEmptyZone(position: DockZonePosition): DockZoneState {
  const isBottom = position === 'bottom'
  return {
    position,
    visible: false,
    size: isBottom ? DEFAULT_BOTTOM_ZONE_SIZE : DEFAULT_SIDE_ZONE_SIZE,
    layout: null,
  }
}

function createDefaultDockState(): WindowDockState {
  return {
    left: createEmptyZone('left'),
    right: createEmptyZone('right'),
    bottom: createEmptyZone('bottom'),
    center: {
      position: 'center',
      visible: true,
      size: 0, // not used — center is flex-1
      layout: null, // initialized with canvas panel by app on startup
    },
  }
}


/** Remove a panel from a tab stack in the layout tree. Returns updated tree or null if stack is now empty. */
function removePanelFromTree(node: DockLayoutNode, panelId: string): DockLayoutNode | null {
  if (node.type === 'tabs') {
    const idx = node.panelIds.indexOf(panelId)
    if (idx === -1) return node
    const newPanelIds = node.panelIds.filter((id) => id !== panelId)
    if (newPanelIds.length === 0) return null
    return {
      ...node,
      panelIds: newPanelIds,
      activeIndex: Math.min(node.activeIndex, newPanelIds.length - 1),
    }
  }
  // Split node — recurse into children
  const newChildren: DockLayoutNode[] = []
  const newRatios: number[] = []
  for (let i = 0; i < node.children.length; i++) {
    const updated = removePanelFromTree(node.children[i], panelId)
    if (updated) {
      newChildren.push(updated)
      newRatios.push(node.ratios[i])
    }
  }
  if (newChildren.length === 0) return null
  if (newChildren.length === 1) return newChildren[0] // collapse single-child split
  // Re-normalize ratios
  const total = newRatios.reduce((a, b) => a + b, 0)
  return {
    ...node,
    children: newChildren,
    ratios: newRatios.map((r) => r / total),
  }
}

/** Replace a tab stack in the layout tree with a new node */
function replaceInTree(
  node: DockLayoutNode,
  stackId: string,
  replacement: DockLayoutNode,
): DockLayoutNode {
  if (node.type === 'tabs') {
    return node.id === stackId ? replacement : node
  }
  return {
    ...node,
    children: node.children.map((child) => replaceInTree(child, stackId, replacement)),
  }
}

/** Find the parent split node of a given child (by id) and the child's index. */
function findParentSplit(
  node: DockLayoutNode,
  childId: string,
): { parent: DockSplitNode; index: number } | null {
  if (node.type !== 'split') return null
  for (let i = 0; i < node.children.length; i++) {
    if (node.children[i].id === childId) {
      return { parent: node, index: i }
    }
  }
  for (const child of node.children) {
    const found = findParentSplit(child, childId)
    if (found) return found
  }
  return null
}

/**
 * Insert a new child into an existing split node adjacent to the given index.
 * When isAfter=true, inserts after; when false, inserts before.
 * Redistributes ratios so the new child gets an equal share taken from
 * the sibling it was split from.
 */
function insertIntoSplit(
  root: DockLayoutNode,
  splitId: string,
  refIndex: number,
  newChild: DockLayoutNode,
  isAfter: boolean = true,
): DockLayoutNode {
  if (root.type === 'tabs') return root
  if (root.type === 'split' && root.id === splitId) {
    const newChildren = [...root.children]
    const insertPos = isAfter ? refIndex + 1 : refIndex
    newChildren.splice(insertPos, 0, newChild)
    const newRatios = [...root.ratios]
    // Split the existing sibling's ratio in half for the new child
    const share = newRatios[refIndex] / 2
    newRatios[refIndex] = share
    newRatios.splice(insertPos, 0, share)
    return { ...root, children: newChildren, ratios: newRatios }
  }
  return {
    ...root,
    children: root.children.map((child) =>
      insertIntoSplit(child, splitId, refIndex, newChild, isAfter),
    ),
  }
}

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

interface DockStoreState {
  zones: WindowDockState
}

interface DockStoreActions {
  // Zone visibility
  toggleZone: (position: DockZonePosition) => void
  setZoneSize: (position: DockZonePosition, size: number) => void

  // Panel placement
  dockPanel: (panelId: string, zone: DockZonePosition, target?: DockDropTarget) => void
  undockPanel: (panelId: string) => void

  // Tab management within a stack
  moveTab: (panelId: string, fromStackId: string, toStackId: string, index?: number) => void
  setActiveTab: (stackId: string, index: number) => void

  // Split management
  setSplitRatio: (splitId: string, ratios: number[]) => void
  collapseStack: (stackId: string) => void

  // Location tracking — the dock location of a panel is DERIVED from the zones
  // tree, not stored. getPanelLocation computes it on demand.
  getPanelLocation: (panelId: string) => PanelLocation | undefined

  // Serialization
  getSnapshot: () => { zones: WindowDockState; locations: Record<string, PanelLocation> }
  restoreSnapshot: (snapshot: { zones: WindowDockState; locations: Record<string, PanelLocation> }) => void
}

export type DockStore = DockStoreState & DockStoreActions

// -----------------------------------------------------------------------------
// Store factory — each dock window gets its own independent store instance
// -----------------------------------------------------------------------------

export function createDockStore(initialState?: { zones: WindowDockState; locations: Record<string, PanelLocation> }) {
  return create<DockStore>((set, get) => ({
  zones: initialState?.zones ?? createDefaultDockState(),

  // --- Zone visibility ---

  toggleZone(position) {
    set((state) => ({
      zones: {
        ...state.zones,
        [position]: {
          ...state.zones[position],
          visible: !state.zones[position].visible,
        },
      },
    }))
  },

  setZoneSize(position, size) {
    const clamped = Math.max(MIN_ZONE_SIZE, size)
    set((state) => ({
      zones: {
        ...state.zones,
        [position]: {
          ...state.zones[position],
          size: clamped,
        },
      },
    }))
  },

  // --- Panel placement ---

  dockPanel(panelId, zone, target) {
    set((state) => {
      const zoneState = state.zones[zone]
      let newLayout = zoneState.layout

      // Guard: remove panel from target zone layout first to prevent duplicates
      if (newLayout) {
        newLayout = removePanelFromTree(newLayout, panelId)
      }

      // A 'tab' target whose stack no longer exists (e.g. it was closed since the
      // user last interacted with it) falls through to the default zone-append
      // below, rather than silently dropping the panel.
      if (target?.type === 'tab' && target.stackId && findTabStack(newLayout, target.stackId)) {
        // Add to existing tab stack
        const stack = findTabStack(newLayout, target.stackId)!
        {
          const insertIndex = target.index ?? stack.panelIds.length
          const newPanelIds = [...stack.panelIds]
          newPanelIds.splice(insertIndex, 0, panelId)
          const updatedStack: DockTabStack = {
            ...stack,
            panelIds: newPanelIds,
            activeIndex: insertIndex,
          }
          newLayout = newLayout
            ? replaceInTree(newLayout, stack.id, updatedStack)
            : updatedStack
        }
      } else if (target?.type === 'split' && target.stackId) {
        // Split an existing stack
        const newStack: DockTabStack = {
          type: 'tabs',
          id: generateId(),
          panelIds: [panelId],
          activeIndex: 0,
        }
        const direction: 'horizontal' | 'vertical' =
          target.edge === 'left' || target.edge === 'right' ? 'horizontal' : 'vertical'
        const isAfter = target.edge === 'right' || target.edge === 'bottom'
        const existingStack = findTabStack(newLayout, target.stackId)
        if (existingStack && newLayout) {
          // If the stack's parent split has the same direction, insert as a
          // flat sibling instead of nesting a new split. This keeps 3+ way
          // splits flat so each resize handle only affects its two neighbors.
          const parentInfo = findParentSplit(newLayout, target.stackId)
          if (parentInfo && parentInfo.parent.direction === direction) {
            newLayout = insertIntoSplit(
              newLayout,
              parentInfo.parent.id,
              parentInfo.index,
              newStack,
              isAfter,
            )
          } else {
            const splitNode: DockSplitNode = {
              type: 'split',
              id: generateId(),
              direction,
              children: isAfter ? [existingStack, newStack] : [newStack, existingStack],
              ratios: [0.5, 0.5],
            }
            newLayout = replaceInTree(newLayout, target.stackId, splitNode)
          }
        }
      } else {
        // Default: add to zone as new tab stack (or append to root stack)
        if (!newLayout) {
          newLayout = {
            type: 'tabs',
            id: generateId(),
            panelIds: [panelId],
            activeIndex: 0,
          }
        } else if (newLayout.type === 'tabs') {
          newLayout = {
            ...newLayout,
            panelIds: [...newLayout.panelIds, panelId],
            activeIndex: newLayout.panelIds.length,
          }
        } else {
          // Root is a split — find the first tab stack and append there
          const firstStack = findFirstTabStack(newLayout)
          if (firstStack) {
            const updatedStack: DockTabStack = {
              ...firstStack,
              panelIds: [...firstStack.panelIds, panelId],
              activeIndex: firstStack.panelIds.length,
            }
            newLayout = replaceInTree(newLayout, firstStack.id, updatedStack)
          }
        }
      }

      return {
        zones: {
          ...state.zones,
          [zone]: {
            ...zoneState,
            visible: true, // auto-show zone when docking
            layout: newLayout,
          },
        },
      }
    })
  },

  undockPanel(panelId) {
    set((state) => {
      // Derive the panel's zone from the tree (no stored reverse-index).
      const zone = findZoneForStack(
        state.zones,
        findStackContainingPanel(state.zones.left.layout, panelId)?.id
          ?? findStackContainingPanel(state.zones.right.layout, panelId)?.id
          ?? findStackContainingPanel(state.zones.bottom.layout, panelId)?.id
          ?? findStackContainingPanel(state.zones.center.layout, panelId)?.id
          ?? '',
      )
      if (!zone) return state

      const zoneState = state.zones[zone]
      if (!zoneState.layout) return state

      const newLayout = removePanelFromTree(zoneState.layout, panelId)

      return {
        zones: {
          ...state.zones,
          [zone]: {
            ...zoneState,
            layout: newLayout,
            // Auto-hide zone if it's now empty (never hide center)
            visible: zone === 'center' ? true : (newLayout !== null ? zoneState.visible : false),
          },
        },
      }
    })
  },

  // --- Tab management ---

  moveTab(panelId, fromStackId, toStackId, index) {
    set((state) => {
      const zones = { ...state.zones }

      // Find and update source and target stacks across all zones
      for (const pos of ALL_ZONES) {
        const zoneState = zones[pos]
        if (!zoneState.layout) continue

        // Remove from source
        const fromStack = findTabStack(zoneState.layout, fromStackId)
        if (fromStack) {
          const newPanelIds = fromStack.panelIds.filter((id) => id !== panelId)
          if (newPanelIds.length === 0) {
            zones[pos] = {
              ...zoneState,
              layout: removePanelFromTree(zoneState.layout, panelId),
            }
          } else {
            const updated: DockTabStack = {
              ...fromStack,
              panelIds: newPanelIds,
              activeIndex: Math.min(fromStack.activeIndex, newPanelIds.length - 1),
            }
            zones[pos] = {
              ...zoneState,
              layout: replaceInTree(zoneState.layout, fromStackId, updated),
            }
          }
        }

        // Add to target
        const toStack = findTabStack(zones[pos].layout, toStackId)
        if (toStack) {
          const insertIndex = index ?? toStack.panelIds.length
          const newPanelIds = [...toStack.panelIds]
          newPanelIds.splice(insertIndex, 0, panelId)
          const updated: DockTabStack = {
            ...toStack,
            panelIds: newPanelIds,
            activeIndex: insertIndex,
          }
          zones[pos] = {
            ...zones[pos],
            layout: zones[pos].layout
              ? replaceInTree(zones[pos].layout!, toStackId, updated)
              : updated,
          }
        }
      }

      return { zones }
    })
  },

  setActiveTab(stackId, index) {
    set((state) => {
      const zones = { ...state.zones }
      for (const pos of ALL_ZONES) {
        const zoneState = zones[pos]
        if (!zoneState.layout) continue
        const stack = findTabStack(zoneState.layout, stackId)
        if (stack && index >= 0 && index < stack.panelIds.length) {
          const updated: DockTabStack = { ...stack, activeIndex: index }
          zones[pos] = {
            ...zoneState,
            layout: replaceInTree(zoneState.layout, stackId, updated),
          }
          break
        }
      }
      return { zones }
    })
  },

  // --- Split management ---

  setSplitRatio(splitId, ratios) {
    set((state) => {
      const zones = { ...state.zones }
      for (const pos of ALL_ZONES) {
        const zoneState = zones[pos]
        if (!zoneState.layout) continue
        const updated = updateSplitRatios(zoneState.layout, splitId, ratios)
        if (updated !== zoneState.layout) {
          zones[pos] = { ...zoneState, layout: updated }
          break
        }
      }
      return { zones }
    })
  },

  collapseStack(stackId) {
    // Forget the active panel up front if it lives in the stack being collapsed,
    // so a gone panel can't keep attracting newly-created panels. Read state
    // outside the set() reducer to keep the reducer side-effect-free.
    const collapsing = (() => {
      for (const pos of ALL_ZONES) {
        const layout = get().zones[pos].layout
        if (layout) {
          const stack = findTabStack(layout, stackId)
          if (stack) return stack.panelIds
        }
      }
      return [] as string[]
    })()
    for (const panelId of collapsing) clearActivePanelIfMatches(panelId)

    set((state) => {
      const zones = { ...state.zones }

      for (const pos of ALL_ZONES) {
        const zoneState = zones[pos]
        if (!zoneState.layout) continue
        const stack = findTabStack(zoneState.layout, stackId)
        if (!stack) continue

        // Remove the entire stack from the tree
        let newLayout: DockLayoutNode | null = zoneState.layout
        for (const panelId of stack.panelIds) {
          if (newLayout) {
            newLayout = removePanelFromTree(newLayout, panelId)
          }
        }

        zones[pos] = {
          ...zoneState,
          layout: newLayout,
          visible: pos === 'center' ? true : (newLayout !== null ? zoneState.visible : false),
        }
        break
      }

      return { zones }
    })
  },

  // --- Location tracking ---

  getPanelLocation(panelId) {
    const zones = get().zones
    const stack = findStackContainingPanel(zones.left.layout, panelId)
      ?? findStackContainingPanel(zones.right.layout, panelId)
      ?? findStackContainingPanel(zones.bottom.layout, panelId)
      ?? findStackContainingPanel(zones.center.layout, panelId)
    if (!stack) return undefined
    const zone = findZoneForStack(zones, stack.id)
    if (!zone) return undefined
    return { type: 'dock', zone, stackId: stack.id }
  },

  // --- Serialization ---
  // `locations` is a derived projection of the zones tree, emitted only for
  // on-disk/cross-window snapshot back-compat; it is not stored live and is
  // re-derived (ignored) on restore.

  getSnapshot() {
    const state = get()
    return {
      zones: state.zones,
      locations: deriveLocations(state.zones),
    }
  },

  restoreSnapshot(snapshot) {
    set({
      zones: snapshot.zones,
    })
  },
}))
}

/** Global singleton dock store — used by the main window */
export const useDockStore = createDockStore()

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

function findFirstTabStack(node: DockLayoutNode): DockTabStack | null {
  if (node.type === 'tabs') return node
  for (const child of node.children) {
    const found = findFirstTabStack(child)
    if (found) return found
  }
  return null
}

/** Derive the {panelId -> dock location} map from the zones tree. Used only to
 *  fill the `locations` field of a snapshot for on-disk/cross-window
 *  back-compat; live code derives single lookups via getPanelLocation. */
function deriveLocations(zones: WindowDockState): Record<string, PanelLocation> {
  const out: Record<string, PanelLocation> = {}
  for (const pos of ALL_ZONES) {
    const layout = zones[pos].layout
    if (!layout) continue
    const walk = (node: DockLayoutNode) => {
      if (node.type === 'tabs') {
        for (const panelId of node.panelIds) {
          out[panelId] = { type: 'dock', zone: pos, stackId: node.id }
        }
      } else {
        for (const child of node.children) walk(child)
      }
    }
    walk(layout)
  }
  return out
}


function updateSplitRatios(
  node: DockLayoutNode,
  splitId: string,
  ratios: number[],
): DockLayoutNode {
  if (node.type === 'split') {
    if (node.id === splitId) {
      return { ...node, ratios }
    }
    const newChildren = node.children.map((child) =>
      updateSplitRatios(child, splitId, ratios),
    )
    if (newChildren.some((c, i) => c !== node.children[i])) {
      return { ...node, children: newChildren }
    }
  }
  return node
}

// -----------------------------------------------------------------------------
// Selectors
// -----------------------------------------------------------------------------

