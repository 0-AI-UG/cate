// =============================================================================
// Dock Tree Utilities — pure tree-traversal functions for dock layout trees.
// Shared between dockStore and useNodeDrag to avoid duplication.
// =============================================================================

import type {
  DockLayoutNode,
  DockTabStack,
  DockZonePosition,
  WindowDockState,
} from '../../shared/types'
import { ALL_ZONES } from '../../shared/types'

/** Find a tab stack by ID anywhere in a layout tree. */
export function findTabStack(
  node: DockLayoutNode | null,
  stackId: string,
): DockTabStack | null {
  if (!node) return null
  if (node.type === 'tabs') {
    return node.id === stackId ? node : null
  }
  for (const child of node.children) {
    const found = findTabStack(child, stackId)
    if (found) return found
  }
  return null
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
  if (!node) return null
  if (node.type === 'tabs') {
    return node.panelIds.includes(panelId) ? node : null
  }
  for (const child of node.children) {
    const found = findStackContainingPanel(child, panelId)
    if (found) return found
  }
  return null
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
