// =============================================================================
// drag/registry — drop-zone registry + edge resolver. Pure module state: no
// React, no IPC. Components register their drop zones here; resolveDrop and
// DragOverlay consult the registry on every move.
// =============================================================================

import type { StoreApi } from 'zustand'
import type { DockZonePosition, PanelType } from '../../shared/types'
import type { DockStore } from '../stores/dockStore'

// -----------------------------------------------------------------------------
// Drop zone registry — components register their bounding rects
// -----------------------------------------------------------------------------

export interface DropZoneEntry {
  id: string
  zone: DockZonePosition
  stackId?: string
  getRect: () => DOMRect | null
  /** Owning DockStore for this drop zone. When omitted, drops use the global
   *  singleton. Per-canvas-node DockStores supply their own here so cross-store
   *  drag-and-drop can route the drop to the correct store. */
  dockStoreApi?: StoreApi<DockStore>
  /** Optional predicate — return false to reject the dragged panel type for
   *  this drop zone. */
  acceptsPanelType?: (type: PanelType) => boolean
}

// The registry now lives on the DragSession (one per window). These free
// functions delegate to the default singleton so non-React callers — and the
// few component sites that still call them directly — continue to work.
// eslint-disable-next-line @typescript-eslint/no-use-before-define
import { getDefaultSession } from './session'

export function registerDropZone(entry: DropZoneEntry): () => void {
  return getDefaultSession().registerDropZone(entry)
}

export function getDropZoneEntries(): readonly DropZoneEntry[] {
  return getDefaultSession().getDropZoneEntries()
}

// -----------------------------------------------------------------------------
// Edge resolver
// -----------------------------------------------------------------------------

const TAB_BAR_DROP_HINT = 38

export function resolveDropEdge(
  cursorX: number,
  cursorY: number,
  rect: DOMRect,
): 'top' | 'bottom' | 'left' | 'right' | 'center' | null {
  const relX = cursorX - rect.left
  const relY = cursorY - rect.top
  const w = rect.width
  const h = rect.height

  if (relY >= 0 && relY < TAB_BAR_DROP_HINT) return 'center'

  const edgeFraction = 0.12
  const EDGE_MAX_PX = 60
  const leftEdge = Math.min(w * edgeFraction, EDGE_MAX_PX)
  const rightEdgeStart = w - leftEdge
  const topEdge = Math.min(h * edgeFraction, EDGE_MAX_PX)
  const bottomEdgeStart = h - topEdge

  if (relY < topEdge && relY < relX && relY < (w - relX)) return 'top'
  if (relY > bottomEdgeStart && (h - relY) < relX && (h - relY) < (w - relX)) return 'bottom'
  if (relX < leftEdge) return 'left'
  if (relX > rightEdgeStart) return 'right'
  return null
}
