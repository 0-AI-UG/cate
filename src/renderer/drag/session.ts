// =============================================================================
// DragSession — mutable drag state (drop zones, canvas stores, active
// dispatcher). A module-level default singleton is exposed via
// `getDefaultSession()`; the live drag is per-window anyway (only one window
// has the cursor), so a single instance is sufficient.
//
// The bug this prevents: `findCanvasStoreForNode` (module-level linear scan)
// used to return a stale match when two canvases held nodes by the same id.
// The reverse `nodeToStore` map below is mutation-maintained from a single
// place (store subscription at registration time) and is the only source of
// truth for "which canvas owns this node."
// =============================================================================

import type { StoreApi } from 'zustand'
import type { Point, Size } from '../../shared/types'
import type { CanvasStore } from '../stores/canvasStore'
import type { DropZoneEntry } from './registry'
import type { DragOpSourceSpec, RuntimeState } from './types'

export interface ActiveDispatch {
  spec: DragOpSourceSpec
  initialClient: Point
  initialScreen: Point
  lastClient: Point
  lastScreen: Point
  grab: Point
  ghostSize: Size
  ghostZoom: number
  runtime: RuntimeState
}

interface CanvasStoreEntry {
  api: StoreApi<CanvasStore>
  unsubscribe: () => void
  /** Last-known set of node ids this store owned — used to diff in the
   *  subscription and update the reverse index without scanning the entire
   *  nodes map on every keystroke. */
  knownNodeIds: Set<string>
}

export class DragSession {
  active: ActiveDispatch | null = null
  listenersAttached = false
  wasDragged: { current: boolean } = { current: false }

  readonly dropZones = new Map<string, DropZoneEntry>()
  private readonly canvasStoreEntries = new Map<string, CanvasStoreEntry>()
  readonly nodeToStore = new Map<string, string>() // nodeId → panelId

  // ---------------------------------------------------------------------------
  // Drop zones
  // ---------------------------------------------------------------------------

  registerDropZone(entry: DropZoneEntry): () => void {
    this.dropZones.set(entry.id, entry)
    return () => {
      const cur = this.dropZones.get(entry.id)
      if (cur === entry) this.dropZones.delete(entry.id)
    }
  }

  getDropZoneEntries(): readonly DropZoneEntry[] {
    return Array.from(this.dropZones.values())
  }

  // ---------------------------------------------------------------------------
  // Canvas stores + nodeToStore reverse index
  // ---------------------------------------------------------------------------

  registerCanvasStore(panelId: string, api: StoreApi<CanvasStore>): () => void {
    const existing = this.canvasStoreEntries.get(panelId)
    if (existing && existing.api === api) {
      // Same store re-registering (e.g. StrictMode double-effect) — no-op.
      return () => this.releaseCanvasStore(panelId, api)
    }
    if (existing) {
      // Different store taking over this panelId — release the old one first.
      this.releaseCanvasStore(panelId, existing.api)
    }

    const knownNodeIds = new Set<string>()
    // Seed the reverse index with whatever nodes the store already holds.
    const seedNodes = api.getState().nodes
    for (const id of Object.keys(seedNodes ?? {})) {
      knownNodeIds.add(id)
      this.nodeToStore.set(id, panelId)
    }

    const unsubscribe = api.subscribe((state) => {
      const nodes = state.nodes ?? {}
      // Adds.
      for (const id of Object.keys(nodes)) {
        if (!knownNodeIds.has(id)) {
          knownNodeIds.add(id)
          this.nodeToStore.set(id, panelId)
        }
      }
      // Removes.
      if (knownNodeIds.size !== Object.keys(nodes).length) {
        for (const id of Array.from(knownNodeIds)) {
          if (!(id in nodes)) {
            knownNodeIds.delete(id)
            if (this.nodeToStore.get(id) === panelId) {
              this.nodeToStore.delete(id)
            }
          }
        }
      }
    })

    this.canvasStoreEntries.set(panelId, { api, unsubscribe, knownNodeIds })
    return () => this.releaseCanvasStore(panelId, api)
  }

  releaseCanvasStore(panelId: string, api?: StoreApi<CanvasStore>): void {
    const entry = this.canvasStoreEntries.get(panelId)
    if (!entry) return
    if (api && entry.api !== api) return
    return this.releaseCanvasStoreInternal(panelId, entry.api)
  }

  private releaseCanvasStoreInternal(panelId: string, api: StoreApi<CanvasStore>): void {
    const entry = this.canvasStoreEntries.get(panelId)
    if (!entry || entry.api !== api) return
    entry.unsubscribe()
    for (const id of entry.knownNodeIds) {
      if (this.nodeToStore.get(id) === panelId) this.nodeToStore.delete(id)
    }
    this.canvasStoreEntries.delete(panelId)
  }

  getCanvasStoreForPanel(panelId: string): StoreApi<CanvasStore> | undefined {
    return this.canvasStoreEntries.get(panelId)?.api
  }

  getPanelIdForCanvasStore(api: StoreApi<CanvasStore>): string | null {
    for (const [panelId, entry] of this.canvasStoreEntries) {
      if (entry.api === api) return panelId
    }
    return null
  }

  getCanvasStoreForNode(nodeId: string): StoreApi<CanvasStore> | null {
    const panelId = this.nodeToStore.get(nodeId)
    if (!panelId) return null
    return this.canvasStoreEntries.get(panelId)?.api ?? null
  }

  /** Compare the session's view of the canvas-store owning `nodeId` against
   *  what a caller is about to use, and log a divergence in dev mode. Returns
   *  whichever store the caller should actually use (session takes precedence
   *  when it has a record). */
  reconcileCanvasStoreForNode(
    nodeId: string,
    callerStore: StoreApi<CanvasStore> | undefined | null,
  ): StoreApi<CanvasStore> | null {
    const sessionStore = this.getCanvasStoreForNode(nodeId)
    if (
      sessionStore &&
      callerStore &&
      sessionStore !== callerStore &&
      ((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV ||
        (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'))
    ) {
      // eslint-disable-next-line no-console
      console.error(
        `[drag] canvas store divergence: nodeId=${nodeId}`,
        { sessionStore, callerStore },
      )
    }
    return sessionStore ?? callerStore ?? null
  }

  getAllCanvasStores(): StoreApi<CanvasStore>[] {
    return Array.from(this.canvasStoreEntries.values(), (e) => e.api)
  }

  // ---------------------------------------------------------------------------
  // Reset (for tests)
  // ---------------------------------------------------------------------------

  resetDispatch(): void {
    this.active = null
    this.listenersAttached = false
    this.wasDragged.current = false
  }
}

// -----------------------------------------------------------------------------
// Default singleton.
// -----------------------------------------------------------------------------

let defaultSession: DragSession = new DragSession()

export function getDefaultSession(): DragSession {
  return defaultSession
}

/** Test-only: replace the default session (so each test starts clean). */
export function __setDefaultSessionForTests(session: DragSession): void {
  defaultSession = session
}
