// =============================================================================
// Drop execution — handles all source→target combinations for dock drag-and-drop.
// Pure functions, no hooks — used by both useNodeDrag and DockTabStack.
// =============================================================================

import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../stores/canvasStore'
import type { DockStore } from '../stores/dockStore'
import type { DockDropTarget } from '../../shared/types'
import type { DragSource } from '../hooks/useDockDrag'
import { useDockDragStore } from '../hooks/useDockDrag'
import { useDockStore } from '../stores/dockStore'
import { findTabStackAcrossZones, findZoneForStack } from '../stores/dockTreeUtils'

/**
 * Execute a drop. Source and target may live in different DockStores
 * (e.g. main dock → per-canvas-node dock, or canvas-node → canvas-node).
 *
 * - `dockStoreApi` is the **target** store (where the panel ends up). Falls
 *   back to the global singleton when omitted.
 * - `sourceDockStoreApi` is the **source** store the panel is removed from.
 *   Falls back to `dockStoreApi` (same store) when omitted, which preserves
 *   the original single-store behaviour.
 */
export function executeDrop(
  panelId: string,
  source: DragSource,
  target: DockDropTarget,
  canvasStoreApi?: StoreApi<CanvasStore>,
  dockStoreApi?: StoreApi<DockStore>,
  sourceDockStoreApi?: StoreApi<DockStore>,
) {
  const targetStore = dockStoreApi ?? useDockStore
  // Resolve the source store: caller-provided takes precedence, otherwise
  // fall back to whatever was stashed on the drag store at startDrag time,
  // and finally to the target store (legacy single-store behaviour).
  const dragSourceStore = useDockDragStore.getState().sourceDockStoreApi
  const sourceStore = sourceDockStoreApi ?? dragSourceStore ?? targetStore
  const targetState = targetStore.getState()

  // --- Self-drop guard: don't remove+re-add to the same stack (same store) ---
  if (
    sourceStore === targetStore &&
    source.type === 'dock' &&
    target.type === 'tab' &&
    target.stackId === source.stackId
  ) {
    return // no-op: dropped onto the same tab stack
  }
  if (
    sourceStore === targetStore &&
    source.type === 'dock' &&
    target.type === 'split' &&
    target.stackId === source.stackId
  ) {
    const stack = findTabStackAcrossZones(targetState.zones, source.stackId)
    if (stack && stack.panelIds.length <= 1) return // no-op
  }

  // --- Validate target BEFORE removing from source ---
  if (target.type === 'zone') {
    removeFromSource(source, panelId, canvasStoreApi, sourceStore)
    targetState.dockPanel(panelId, target.zone)
  } else if (target.type === 'tab') {
    const zone = findZoneForStack(targetState.zones, target.stackId)
    if (!zone) return // abort — don't remove from source
    removeFromSource(source, panelId, canvasStoreApi, sourceStore)
    targetState.dockPanel(panelId, zone, target)
  } else if (target.type === 'split') {
    const zone = findZoneForStack(targetState.zones, target.stackId)
    if (!zone) return // abort — don't remove from source
    removeFromSource(source, panelId, canvasStoreApi, sourceStore)
    targetState.dockPanel(panelId, zone, target)
  }
}

/** Remove panel from its current source location */
function removeFromSource(
  source: DragSource,
  panelId: string,
  canvasStoreApi?: StoreApi<CanvasStore>,
  sourceStore?: StoreApi<DockStore>,
) {
  if (source.type === 'dock') {
    (sourceStore ?? useDockStore).getState().undockPanel(panelId)
  }
  if (source.type === 'canvas' && canvasStoreApi) {
    // If the canvas node owns a per-node DockStore (and the caller supplied
    // it as sourceStore), undock the panel from that store FIRST so the
    // per-node layout is clean before the canvas node is removed. This
    // avoids orphaning the panel's DOM (e.g. the xterm element) during the
    // unmount/mount race with the target dock.
    if (sourceStore) {
      try {
        sourceStore.getState().undockPanel(panelId)
      } catch {
        /* best-effort — fall through to node removal */
      }
    }
    canvasStoreApi.getState().finalizeRemoveNode(source.nodeId)
  }
}
