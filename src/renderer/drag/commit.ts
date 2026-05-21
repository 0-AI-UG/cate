// =============================================================================
// commitDrop — apply a resolved DropTarget. Pure switch over target.kind. Owns
// every source→target combination directly (dock execution is inlined; no
// translation back to a legacy union). Cross-window / detach are delegated to
// caller-provided callbacks so the dispatcher owns the IPC + history side
// effects.
// =============================================================================

import type { StoreApi } from 'zustand'
import type { PanelTransferSnapshot, PanelType, DockDropTarget } from '../../shared/types'
import type { DragSource, DropTarget } from './types'
import type { CanvasStore } from '../stores/canvasStore'
import { findZoneForStack } from '../stores/dockTreeUtils'
import { getDefaultSession } from './session'

export interface CommitContext {
  /** Cross-window resolve callback — ask the main process whether another
   *  window claimed the drop. */
  crossWindowResolve(): Promise<{ claimed: boolean }>
  /** Cancel the active cross-window drag (no window claimed it). */
  crossWindowCancel(): void
  /** Detach the panel into a new dock window. Returns the new windowId, or
   *  null if the main process refused (e.g. fullscreen lock). */
  dragDetach(snapshot: PanelTransferSnapshot, workspaceId: string): Promise<number | null>
  /** Build the transfer snapshot for the source. Called once if a detach is
   *  actually required. */
  buildSnapshot(): PanelTransferSnapshot | null
  workspaceId: string
  /** Notified after the panel is removed from the source canvas — used by the
   *  hook to release terminal PTYs / xterm instances. */
  onRemovedFromCanvas?: (panelId: string, panelType: PanelType) => void
  /** Same-window move hook — arms the terminal registry so a remounted
   *  TerminalPanel reconnects to the live PTY instead of spawning a fresh one. */
  prepareLocalRemount?: (panelId: string, panelType: PanelType) => void
}

export async function commitDrop(
  source: DragSource,
  target: DropTarget,
  panel: { id: string; type: PanelType; title: string },
  ctx: CommitContext,
): Promise<void> {
  switch (target.kind) {
    case 'canvas-reposition': {
      target.canvasStoreApi.getState().moveNode(target.nodeId, target.origin)
      applyRegionContainment(target.canvasStoreApi, target.nodeId)
      return
    }

    case 'canvas-add': {
      ctx.prepareLocalRemount?.(source.panelId, panel.type)
      // Remove the panel from its current location first so addNode doesn't
      // race with a stale duplicate (terminal PTY, xterm DOM, etc.).
      removeFromSource(source, panel.type, ctx)
      const targetState = target.canvasStoreApi.getState()
      const newNodeId = targetState.addNode(panel.id, panel.type, target.origin, target.size)
      target.canvasStoreApi.getState().resizeNode(newNodeId, target.size)
      target.canvasStoreApi.getState().focusNode(newNodeId)
      return
    }

    case 'dock-zone': {
      // A panel-window source can't land on a dock/canvas target inside its
      // own window (no zones registered there); cross-window drops route
      // through 'detach' and the receiver. So if we somehow get here with a
      // panel-window source, drop the commit silently.
      if (source.origin.kind === 'panel-window') return
      ctx.prepareLocalRemount?.(source.panelId, panel.type)
      removeFromSource(source, panel.type, ctx)
      target.dockStoreApi.getState().dockPanel(panel.id, target.zone)
      return
    }

    case 'dock-tab':
    case 'dock-split': {
      if (source.origin.kind === 'panel-window') return
      const targetState = target.dockStoreApi.getState()
      const zone = findZoneForStack(targetState.zones, target.stackId)
      // Stack vanished between resolve and commit — abort without touching the
      // source.
      if (!zone) return
      const dockTarget: DockDropTarget =
        target.kind === 'dock-tab'
          ? { type: 'tab', stackId: target.stackId }
          : { type: 'split', stackId: target.stackId, edge: target.edge }
      ctx.prepareLocalRemount?.(source.panelId, panel.type)
      removeFromSource(source, panel.type, ctx)
      targetState.dockPanel(panel.id, zone, dockTarget)
      return
    }

    case 'detach': {
      // Ask the main process whether any other window claimed the cross-window
      // drag. If so, just clean up the source.
      const { claimed } = await ctx.crossWindowResolve()
      if (claimed) {
        removeFromSource(source, panel.type, ctx)
        ctx.onRemovedFromCanvas?.(source.panelId, panel.type)
        return
      }
      // No window claimed. Panel-window sources are already in their own
      // detached window — spawning ANOTHER detached window would be
      // surprising, so just cancel the drag and leave the source as-is.
      if (source.origin.kind === 'panel-window') {
        ctx.crossWindowCancel()
        return
      }
      // Otherwise: spawn a new dock window holding the panel.
      const snapshot = ctx.buildSnapshot()
      if (!snapshot) {
        ctx.crossWindowCancel()
        return
      }
      const winId = await ctx.dragDetach(snapshot, ctx.workspaceId)
      if (winId != null) {
        removeFromSource(source, panel.type, ctx)
        ctx.onRemovedFromCanvas?.(source.panelId, panel.type)
      }
      return
    }
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Region containment: if the dropped node's bbox overlaps a region by >50%,
 *  assign that region. */
function applyRegionContainment(
  canvasStoreApi: StoreApi<CanvasStore>,
  nodeId: string,
): void {
  const state = canvasStoreApi.getState()
  const node = state.nodes[nodeId]
  if (!node) return
  let bestRegion: string | undefined
  for (const region of Object.values(state.regions)) {
    const overlapX = Math.max(
      0,
      Math.min(
        node.origin.x + node.size.width,
        region.origin.x + region.size.width,
      ) - Math.max(node.origin.x, region.origin.x),
    )
    const overlapY = Math.max(
      0,
      Math.min(
        node.origin.y + node.size.height,
        region.origin.y + region.size.height,
      ) - Math.max(node.origin.y, region.origin.y),
    )
    const overlapArea = overlapX * overlapY
    const nodeArea = node.size.width * node.size.height
    if (nodeArea > 0 && overlapArea / nodeArea > 0.5) {
      bestRegion = region.id
      break
    }
  }
  if (bestRegion !== node.regionId) {
    state.setNodeRegion(nodeId, bestRegion)
  }
}

function removeFromSource(
  source: DragSource,
  panelType: PanelType,
  ctx: CommitContext,
): void {
  const origin = source.origin
  if (origin.kind === 'dock-tab') {
    try {
      origin.dockStoreApi.getState().undockPanel(source.panelId)
    } catch {
      // Swallow — the source dock may have unmounted mid-drag (cross-window).
    }
  } else if (origin.kind === 'canvas-node') {
    const store = getDefaultSession().reconcileCanvasStoreForNode(
      origin.nodeId,
      origin.canvasStoreApi,
    )
    store?.getState().finalizeRemoveNode(origin.nodeId)
  } else if (origin.kind === 'panel-window') {
    // Single-panel detached window — the panel left, so close the host.
    window.close()
  }
}
