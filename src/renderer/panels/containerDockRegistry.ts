// Container panels own private DockStores. This lets drag/commit code tell a
// container's store apart from the window dock and canvas-node mini-docks.

import type { StoreApi } from 'zustand'
import type { DockLayoutNode, WindowDockState } from '../../shared/types'
import type { DockStore } from '../stores/dockStore'

const containerStores = new WeakSet<object>()
const storesByPanel = new Map<string, StoreApi<DockStore>>()

export function registerContainerDockStore(panelId: string, store: StoreApi<DockStore>): void {
  containerStores.add(store)
  storesByPanel.set(panelId, store)
}

export function unregisterContainerDockStore(panelId: string, store: StoreApi<DockStore>): void {
  if (storesByPanel.get(panelId) === store) storesByPanel.delete(panelId)
}

/** The live (mounted) DockStore of a container panel, if any. */
export function getContainerDockStore(panelId: string): StoreApi<DockStore> | undefined {
  return storesByPanel.get(panelId)
}

export function isContainerDockStore(store: StoreApi<DockStore>): boolean {
  return containerStores.has(store)
}

/** A DockStore zone set whose only visible zone is `center` holding `layout`. */
export function containerZones(layout: DockLayoutNode | null): WindowDockState {
  return {
    left:   { position: 'left',   visible: false, size: 260, layout: null },
    right:  { position: 'right',  visible: false, size: 260, layout: null },
    bottom: { position: 'bottom', visible: false, size: 240, layout: null },
    center: { position: 'center', visible: true,  size: 0,   layout },
  }
}

/** An empty tab stack — what a container shows once its last panel leaves. */
export function emptyContainerLayout(): DockLayoutNode {
  return { type: 'tabs', id: crypto.randomUUID(), panelIds: [], activeIndex: 0 }
}
