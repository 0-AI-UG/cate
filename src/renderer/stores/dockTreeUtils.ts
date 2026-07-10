// =============================================================================
// Dock Tree Utilities — pure tree-traversal functions for dock layout trees.
// Shared between dockStore and drag resolution to avoid duplication.
// =============================================================================

import type {
  DockLayoutNode,
  DockTabStack,
  DockZonePosition,
  WindowDockState,
} from '../../shared/types'
import { ALL_ZONES } from '../../shared/types'

/** Visit every node in depth-first order. All dock-tree queries build on this
 * primitive so recursive traversal cannot drift between callers. */
export function visitDockTree(
  node: DockLayoutNode | null | undefined,
  visitor: (node: DockLayoutNode) => boolean | void,
): boolean {
  if (!node) return false
  if (visitor(node) === true) return true
  if (node.type === 'split') {
    for (const child of node.children) {
      if (visitDockTree(child, visitor)) return true
    }
  }
  return false
}

/** Return a structurally cloned tree with panel ids transformed. */
export function mapDockPanelIds(
  node: DockLayoutNode | null,
  mapPanelId: (panelId: string) => string,
): DockLayoutNode | null {
  if (!node) return null
  if (node.type === 'tabs') {
    return { ...node, panelIds: node.panelIds.map(mapPanelId) }
  }
  return { ...node, children: node.children.map((child) => mapDockPanelIds(child, mapPanelId)!) }
}

/** Find a tab stack by ID anywhere in a layout tree. */
export function findTabStack(
  node: DockLayoutNode | null,
  stackId: string,
): DockTabStack | null {
  let result: DockTabStack | null = null
  visitDockTree(node, (candidate) => {
    if (candidate.type === 'tabs' && candidate.id === stackId) {
      result = candidate
      return true
    }
  })
  return result
}

export function findFirstTabStack(node: DockLayoutNode | null): DockTabStack | null {
  let result: DockTabStack | null = null
  visitDockTree(node, (candidate) => {
    if (candidate.type === 'tabs') {
      result = candidate
      return true
    }
  })
  return result
}

/** Find which zone a given tab stack belongs to. */
export function findZoneForStack(
  zones: WindowDockState,
  stackId: string,
): DockZonePosition | null {
  for (const pos of ALL_ZONES) {
    if (findTabStack(zones[pos].layout, stackId)) return pos
  }
  return null
}

/** Find the first tab stack containing a given panelId anywhere in a layout tree. */
export function findStackContainingPanel(
  node: DockLayoutNode | null,
  panelId: string,
): DockTabStack | null {
  let result: DockTabStack | null = null
  visitDockTree(node, (candidate) => {
    if (candidate.type === 'tabs' && candidate.panelIds.includes(panelId)) {
      result = candidate
      return true
    }
  })
  return result
}

/** Find a tab stack by ID across all zones. */
export function findTabStackAcrossZones(
  zones: WindowDockState,
  stackId: string,
): DockTabStack | null {
  for (const pos of ALL_ZONES) {
    const found = findTabStack(zones[pos].layout, stackId)
    if (found) return found
  }
  return null
}

/** Find the first tab stack containing a given panelId across all zones. */
export function findStackContainingPanelAcrossZones(
  zones: WindowDockState,
  panelId: string,
): DockTabStack | null {
  for (const pos of ALL_ZONES) {
    const found = findStackContainingPanel(zones[pos].layout, panelId)
    if (found) return found
  }
  return null
}
