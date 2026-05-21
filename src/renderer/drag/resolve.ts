// =============================================================================
// resolveDrop — pure hit-test pipeline producing a typed DropTarget.
// Reuses the drop-zone registry + edge resolver from drag/registry, and routes
// "cursor over canvas surface" to canvas-reposition / canvas-add.
//
// The DOM dependency (document.elementFromPoint + canvas store lookup) is
// passed as a DropEnvironment so the function itself stays pure and the
// dispatcher (or a test) supplies the real or fake environment.
// =============================================================================

import type { StoreApi } from 'zustand'
import type { PanelType, Point, Size } from '../../shared/types'
import type { CanvasStore } from '../stores/canvasStore'
import type { DragSource, DropTarget } from './types'
import {
  getDropZoneEntries,
  resolveDropEdge,
  type DropZoneEntry,
} from './registry'
import { getOrCreateCanvasStoreForPanel } from '../stores/canvasStore'
import { findNodeIdForDockStore } from '../panels/nodeDockRegistry'
import { getDefaultSession } from './session'
import { cursorToCanvasOrigin } from './geometry'
import { findTabStackAcrossZones } from '../stores/dockTreeUtils'
import type { WindowDockState } from '../../shared/types'

// -----------------------------------------------------------------------------
// DropEnvironment — DOM/store lookups that resolveDrop needs. The dispatcher
// passes the real-DOM implementation via `defaultDropEnvironment`. Tests can
// supply a fake.
// -----------------------------------------------------------------------------

export interface DropEnvironment {
  /** Returns the canvas container under the cursor (or null). */
  canvasAtCursor(
    client: Point,
  ): { panelId: string; rect: DOMRect; canvasStoreApi: StoreApi<CanvasStore> } | null
  /** Dock zones registered for hit-testing. */
  readonly dropZones: readonly DropZoneEntry[]
  /** Resolve a dock-store back to the canvas node it lives inside (or null
   *  for the global dock). */
  findOwningCanvasForDockStore(
    dockStoreApi: unknown,
    sourceNodeId: string | undefined,
  ): { nodeId: string; canvasStoreApi: StoreApi<CanvasStore> } | null
}

/** Default DropEnvironment that reads from the real DOM + global registries. */
export const defaultDropEnvironment: DropEnvironment = {
  canvasAtCursor(client) {
    const el = document.elementFromPoint(client.x, client.y) as HTMLElement | null
    if (!el) return null
    const container = el.closest<HTMLElement>('[data-canvas-container]')
    if (!container) return null
    const panelId = container.getAttribute('data-canvas-panel-id')
    if (!panelId) return null
    const canvasStoreApi = getOrCreateCanvasStoreForPanel(panelId) as StoreApi<CanvasStore>
    return { panelId, rect: container.getBoundingClientRect(), canvasStoreApi }
  },
  get dropZones() {
    return getDropZoneEntries()
  },
  findOwningCanvasForDockStore(dockStoreApi, sourceNodeId) {
    const nodeId = sourceNodeId ?? findNodeIdForDockStore(dockStoreApi as never)
    if (!nodeId) return null
    const canvasStoreApi = getDefaultSession().getCanvasStoreForNode(nodeId)
    if (!canvasStoreApi) return null
    return { nodeId, canvasStoreApi }
  },
}

/** Resolve cursor + source into a typed DropTarget. */
export function resolveDrop(
  cursor: { client: Point; screen: Point; insideWindow: boolean },
  source: DragSource,
  grab: Point,
  ghostSize: Size,
  panelType: PanelType,
  env: DropEnvironment = defaultDropEnvironment,
): DropTarget | null {
  if (!cursor.insideWindow) {
    return { kind: 'detach', screen: cursor.screen }
  }

  // --- 1. Dock zones (main dock + every per-node mini-dock) ---
  const dockTarget = resolveDockHit(cursor.client, source, panelType, env)
  if (dockTarget) return dockTarget

  // --- 2. Canvas surface under cursor ---
  const canvasTarget = resolveCanvasHit(cursor, source, grab, ghostSize, env)
  if (canvasTarget) return canvasTarget

  return null
}

// -----------------------------------------------------------------------------
// Dock-zone hit testing
// -----------------------------------------------------------------------------

function resolveDockHit(
  client: Point,
  source: DragSource,
  panelType: PanelType,
  env: DropEnvironment,
): DropTarget | null {
  type Hit = { entry: DropZoneEntry; rect: DOMRect; area: number }
  const hits: Hit[] = []
  // When dragging a whole canvas node, ignore drop zones owned by that same
  // node's mini-dock — dropping there would remove the source node (committing
  // the drop on its own about-to-be-destroyed dock) and the panel would vanish.
  const sourceOwnNodeId =
    source.origin.kind === 'canvas-node' ? source.origin.nodeId : null
  for (const entry of env.dropZones) {
    if (entry.acceptsPanelType && !entry.acceptsPanelType(panelType)) continue
    if (sourceOwnNodeId && entry.dockStoreApi) {
      const owning = env.findOwningCanvasForDockStore(entry.dockStoreApi, undefined)
      if (owning && owning.nodeId === sourceOwnNodeId) continue
    }
    const rect = entry.getRect()
    if (!rect) continue
    if (
      client.x >= rect.left &&
      client.x <= rect.right &&
      client.y >= rect.top &&
      client.y <= rect.bottom
    ) {
      hits.push({ entry, rect, area: rect.width * rect.height })
    }
  }
  if (hits.length === 0) return null

  // Prefer stack-level entries over zone-level, and tighter (smaller-area) fits.
  hits.sort((a, b) => {
    const specA = a.entry.stackId ? 0 : 1
    const specB = b.entry.stackId ? 0 : 1
    if (specA !== specB) return specA - specB
    return a.area - b.area
  })
  const best = hits[0]
  const targetStore = best.entry.dockStoreApi
  if (!targetStore) return null

  if (best.entry.stackId) {
    const edge = resolveDropEdge(client.x, client.y, best.rect)
    if (edge === null) return null
    const isSelfStack =
      source.origin.kind === 'dock-tab' &&
      source.origin.dockStoreApi === targetStore &&
      best.entry.stackId === source.origin.stackId
    if (isSelfStack) {
      // Single-panel self-drops are trivial no-ops; multi-panel self-drops
      // (center re-dock or edge split) produce real layout changes.
      const zones = (targetStore.getState() as { zones?: WindowDockState }).zones
      const stack = zones ? findTabStackAcrossZones(zones, best.entry.stackId) : null
      if (!stack || stack.panelIds.length <= 1) return null
    }
    if (edge === 'center') {
      return { kind: 'dock-tab', dockStoreApi: targetStore, stackId: best.entry.stackId }
    }
    return {
      kind: 'dock-split',
      dockStoreApi: targetStore,
      stackId: best.entry.stackId,
      edge,
    }
  }
  return { kind: 'dock-zone', dockStoreApi: targetStore, zone: best.entry.zone }
}

// -----------------------------------------------------------------------------
// Canvas-surface hit testing
// -----------------------------------------------------------------------------

function resolveCanvasHit(
  cursor: { client: Point },
  source: DragSource,
  grab: Point,
  ghostSize: Size,
  env: DropEnvironment,
): DropTarget | null {
  const hit = env.canvasAtCursor(cursor.client)
  if (!hit) return null
  const { canvasStoreApi, rect } = hit
  const state = canvasStoreApi.getState() as {
    zoomLevel: number
    viewportOffset: Point
  }

  const origin = cursorToCanvasOrigin(
    cursor,
    rect,
    state.zoomLevel,
    state.viewportOffset,
    grab,
  )

  // Source is a canvas-node already on this canvas → reposition (move existing).
  if (source.origin.kind === 'canvas-node' && source.origin.canvasStoreApi === canvasStoreApi) {
    return {
      kind: 'canvas-reposition',
      canvasStoreApi: source.origin.canvasStoreApi,
      nodeId: source.origin.nodeId,
      origin,
    }
  }

  // (A dock-tab dragged from a per-canvas-node mini-dock back onto its own
  // canvas falls through to canvas-add below — the user is detaching that
  // specific tab into a new node. Single-tab tab-drags are dispatched as
  // `canvas-node` specs by the host, so they hit the branch above instead.)

  return {
    kind: 'canvas-add',
    canvasStoreApi,
    origin,
    size: ghostSize,
  }
}
