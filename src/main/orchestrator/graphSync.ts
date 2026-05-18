// =============================================================================
// Graph sync — bridges renderer canvasStore/appStore state into the main
// process orchestrator registry, and pushes in-flight ask state back to the
// renderer so it can animate the connection line.
//
// Renderer → main:  ORCH_REGISTRY_SYNC (full snapshot per window)
// Main → renderer:  ORCH_INFLIGHT_UPDATE (which connection edges are active)
// =============================================================================

import { ipcMain } from 'electron'
import {
  ORCH_REGISTRY_SYNC,
  ORCH_INFLIGHT_UPDATE,
} from '../../shared/ipc-channels'
import { applySnapshot, clearWindow, type RegistrySnapshot } from './registry'
import { sendToWindow, getAllWindows, windowFromEvent } from '../windowRegistry'

export function registerGraphSync(): void {
  ipcMain.handle(ORCH_REGISTRY_SYNC, async (event, snap: Omit<RegistrySnapshot, 'windowId'>) => {
    const win = windowFromEvent(event)
    if (!win) return
    applySnapshot({ ...snap, windowId: win.id })
  })
}

export function unregisterGraphSyncForWindow(windowId: number): void {
  clearWindow(windowId)
}

/** Notify every renderer window that an ask is starting/stopping between two
 *  canvas nodes, so the connection line can animate. We broadcast to all
 *  windows rather than tracking which window owns the nodes — windows that
 *  don't have those nodes will simply ignore the message. */
export function broadcastInFlight(fromNodeId: string, toNodeId: string, active: boolean): void {
  for (const win of getAllWindows()) {
    sendToWindow(win.id, ORCH_INFLIGHT_UPDATE, { fromNodeId, toNodeId, active })
  }
}
