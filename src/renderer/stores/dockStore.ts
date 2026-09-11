// =============================================================================
// Dock Store — Zustand state for dock zone layouts.
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
  DockStateSnapshot,
} from '../../shared/types'
import { ALL_ZONES } from '../../shared/types'
import {
  findTabStack,
  findZoneForStack,
  findStackContainingPanelAcrossZones,
  findTabStackAcrossZones,
  findFirstTabStack,
} from './dockTreeUtils'
import { clearActivePanelIfMatches } from '../lib/activePanel'
import { generateId } from './canvas/helpers'

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const DEFAULT_SIDE_ZONE_SIZE = 260
export const DEFAULT_BOTTOM_ZONE_SIZE = 240
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

export function createDefaultDockState(): WindowDockState {
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
export function removePanelFromTree(node: DockLayoutNode, panelId: string): DockLayoutNode | null {
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
 * Shares the row/column equally when a new sibling is added.
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
    const newRatios = newChildren.map(() => 1 / newChildren.length)
    return { ...root, children: newChildren, ratios: newRatios }
  }
  return {
    ...root,
    children: root.children.map((child) =>
      insertIntoSplit(child, splitId, refIndex, newChild, isAfter),
    ),
  }
}

function collectPanelIdsInTree(node: DockLayoutNode): string[] {
  if (node.type === 'tabs') return [...node.panelIds]
  return node.children.flatMap(collectPanelIdsInTree)
}

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

interface DockStoreState {
  presentation: DockPresentation | null
  zones: WindowDockState
}

export interface DockPresentation {
  /** The real stack containing the presented panel(s). */
  stackId: string
  /** Set for a panel promoted out of a canvas. Split merges apply to the stack. */
  panelId?: string
  zone: DockZonePosition
  /** Layout before the structural transformation. */
  restoreLayout: DockLayoutNode
  /** Layout produced by the transformation. Used to reject unsafe restores. */
  expectedLayout: DockLayoutNode
  /** Canvas promotion has a second source tree which must still be unchanged. */
  canRestoreExternal?: () => boolean
  restoreExternal?: () => void
  dispose?: () => void
}

interface DockStoreActions {
  mergeSplitToStack: (stackId: string) => void
  beginPresentation: (presentation: DockPresentation) => void
  discardPresentation: () => void
  canRestorePresentation: (stackId: string) => boolean
  restorePresentation: (stackId: string) => boolean
  // Zone visibility
  toggleZone: (position: DockZonePosition) => void
  setZoneSize: (position: DockZonePosition, size: number) => void

  // Panel placement
  /** `activate: false` appends in the background without selecting the new tab
   * or opening a hidden zone (used by host-API creates). */
  dockPanel: (panelId: string, zone: DockZonePosition, target?: DockDropTarget, activate?: boolean) => void
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
  getSnapshot: () => DockStateSnapshot
  restoreSnapshot: (snapshot: DockStateSnapshot) => void
}

export type DockStore = DockStoreState & DockStoreActions

/** Active-tab changes are harmless, but any structural difference makes a
 * presentation unsafe to reverse. */
function samePresentationLayout(a: DockLayoutNode | null, b: DockLayoutNode | null): boolean {
  if (!a || !b) return a === b
  if (a.type !== b.type || a.id !== b.id) return false
  if (a.type === 'tabs' && b.type === 'tabs') {
    return a.panelIds.length === b.panelIds.length
      && a.panelIds.every((panelId, index) => panelId === b.panelIds[index])
  }
  if (a.type === 'split' && b.type === 'split') {
    return a.direction === b.direction
      && a.children.length === b.children.length
      && a.children.every((child, index) => samePresentationLayout(child, b.children[index]))
  }
  return false
}

// -----------------------------------------------------------------------------
// Store factory — each dock window gets its own independent store instance
// -----------------------------------------------------------------------------

export function createDockStore(initialState?: DockStateSnapshot) {
  const store = create<DockStore>((set, get) => ({
  zones: initialState?.zones ?? createDefaultDockState(),
  presentation: null,
  mergeSplitToStack(stackId) {
    set((state) => {
      if (state.presentation) return state
      const zone = findZoneForStack(state.zones, stackId)
      if (!zone) return state
      const layout = state.zones[zone].layout
      const target = findTabStack(layout, stackId)
      if (!layout || layout.type !== 'split' || !target) return state

      const panelIds = collectPanelIdsInTree(layout)
      const activePanelId = target.panelIds[target.activeIndex] ?? target.panelIds[0]
      const merged: DockTabStack = {
        type: 'tabs',
        id: target.id,
        panelIds,
        activeIndex: Math.max(0, panelIds.indexOf(activePanelId)),
      }
      return {
        zones: {
          ...state.zones,
          [zone]: { ...state.zones[zone], layout: merged },
        },
        presentation: {
          stackId: merged.id,
          zone,
          restoreLayout: layout,
          expectedLayout: merged,
        },
      }
    })
  },
  beginPresentation(presentation) {
    set((state) => state.presentation ? state : { presentation })
  },
  discardPresentation() {
    get().presentation?.dispose?.()
    set({ presentation: null })
  },
  canRestorePresentation(stackId) {
    const state = get()
    const presentation = state.presentation
    if (!presentation || presentation.stackId !== stackId) return false
    return samePresentationLayout(state.zones[presentation.zone].layout, presentation.expectedLayout)
      && (presentation.canRestoreExternal?.() ?? true)
  },
  restorePresentation(stackId) {
    if (!get().canRestorePresentation(stackId)) return false
    const presentation = get().presentation!
    presentation.dispose?.()
    presentation.restoreExternal?.()
    set((state) => ({
      zones: {
        ...state.zones,
        [presentation.zone]: {
          ...state.zones[presentation.zone],
          layout: presentation.restoreLayout,
        },
      },
      presentation: null,
    }))
    return true
  },

  // --- Zone visibility ---

  toggleZone(position) {
    set((state) => {
      const zones = {
        ...state.zones,
        [position]: { ...state.zones[position], visible: !state.zones[position].visible },
      }
      return { zones, presentation: state.presentation }
    })
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

  dockPanel(panelId, zone, target, activate = true) {
    set((state) => {
      // A panel has exactly one dock owner. Remove any existing occurrence
      // before placing it, even when the caller skips an explicit undock.
      const zones = { ...state.zones }
      for (const position of ALL_ZONES) {
        const current = zones[position]
        if (!current.layout) continue
        const layout = removePanelFromTree(current.layout, panelId)
        if (layout !== current.layout) {
          zones[position] = {
            ...current,
            layout,
            visible: position === 'center' ? true : (layout !== null ? current.visible : false),
          }
        }
      }
      const zoneState = zones[zone]
      let newLayout = zoneState.layout

      // A 'tab' target whose stack no longer exists (e.g. it was closed since the
      // user last interacted with it) falls through to the default zone-append
      // below, rather than silently dropping the panel.
      if (target?.type === 'tab' && target.stackId && findTabStack(newLayout, target.stackId)) {
        // Add to existing tab stack
        const stack = findTabStack(newLayout, target.stackId)!
        {
          const insertIndex = Math.max(0, Math.min(target.index ?? stack.panelIds.length, stack.panelIds.length))
          const newPanelIds = [...stack.panelIds]
          newPanelIds.splice(insertIndex, 0, panelId)
          const updatedStack: DockTabStack = {
            ...stack,
            panelIds: newPanelIds,
            activeIndex: activate ? insertIndex : stack.activeIndex,
          }
          newLayout = newLayout
            ? replaceInTree(newLayout, stack.id, updatedStack)
            : updatedStack
        }
      } else if (
        target?.type === 'split'
        && target.stackId
        && findTabStack(newLayout, target.stackId)
      ) {
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
            activeIndex: activate ? newLayout.panelIds.length : newLayout.activeIndex,
          }
        } else {
          // Root is a split — find the first tab stack and append there
          const firstStack = findFirstTabStack(newLayout)
          if (firstStack) {
            const updatedStack: DockTabStack = {
              ...firstStack,
              panelIds: [...firstStack.panelIds, panelId],
              activeIndex: activate ? firstStack.panelIds.length : firstStack.activeIndex,
            }
            newLayout = replaceInTree(newLayout, firstStack.id, updatedStack)
          }
        }
      }

      zones[zone] = { ...zoneState, visible: activate ? true : zoneState.visible, layout: newLayout }
      return { zones, presentation: state.presentation }
    })
  },

  undockPanel(panelId) {
    set((state) => {
      // Derive the panel's zone from the tree (no stored reverse-index).
      const zone = findZoneForStack(
        state.zones,
        findStackContainingPanelAcrossZones(state.zones, panelId)?.id ?? '',
      )
      if (!zone) return state

      const zoneState = state.zones[zone]
      if (!zoneState.layout) return state

      const newLayout = removePanelFromTree(zoneState.layout, panelId)

      return { zones: {
        ...state.zones,
        [zone]: {
          ...zoneState,
          layout: newLayout,
          // Auto-hide zone if it's now empty (never hide center)
          visible: zone === 'center' ? true : (newLayout !== null ? zoneState.visible : false),
        },
      }, presentation: state.presentation }
    })
  },

  // --- Tab management ---

  moveTab(panelId, fromStackId, toStackId, index) {
    set((state) => {
      const source = findTabStackAcrossZones(state.zones, fromStackId)
      const target = findTabStackAcrossZones(state.zones, toStackId)
      if (!source?.panelIds.includes(panelId) || !target) return state
      if (fromStackId === toStackId && source.panelIds.length === 1) return state
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
            const layout = removePanelFromTree(zoneState.layout, panelId)
            zones[pos] = {
              ...zoneState,
              layout,
              visible: pos === 'center' ? true : (layout !== null ? zoneState.visible : false),
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
          const insertIndex = Math.max(0, Math.min(index ?? toStack.panelIds.length, toStack.panelIds.length))
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

      return { zones, presentation: state.presentation }
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
          return { zones, presentation: state.presentation }
        }
      }
      return state
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

      return { zones, presentation: state.presentation }
    })
  },

  // --- Location tracking ---

  getPanelLocation(panelId) {
    const zones = get().zones
    const stack = findStackContainingPanelAcrossZones(zones, panelId)
    if (!stack) return undefined
    const zone = findZoneForStack(zones, stack.id)
    if (!zone) return undefined
    return { type: 'dock', zone, stackId: stack.id }
  },

  // --- Serialization ---
  getSnapshot() {
    return { zones: get().zones }
  },

  restoreSnapshot(snapshot) {
    get().presentation?.dispose?.()
    set({
      zones: snapshot.zones,
      presentation: null,
    })
  },
  }))

  // Presentation is a one-shot reverse transaction, not a mode. The first
  // incompatible structural change consumes it permanently. In particular,
  // moving or splitting a panel promoted from a canvas must not allow Restore
  // to reappear if the user later happens to recreate the old topology.
  store.subscribe((state) => {
    const presentation = state.presentation
    if (!presentation) return
    const outerUnchanged = samePresentationLayout(
      state.zones[presentation.zone].layout,
      presentation.expectedLayout,
    )
    if (!outerUnchanged || !(presentation.canRestoreExternal?.() ?? true)) {
      state.discardPresentation()
    }
  })

  return store
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

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
