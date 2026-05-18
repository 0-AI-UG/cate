// =============================================================================
// portalWcMap — main-process inverse map from webContents id → portal panel.
//
// The renderer's portalRegistry knows the (panelId, webContentsId, BrowserWindow
// owner) tuple as soon as a BrowserPanel's <webview> fires dom-ready. It pushes
// each pairing here via ORCH_PORTAL_WC_REGISTER, and on unmount removes it.
//
// We need this mapping in main for popup tracking: webSecurity's
// setWindowOpenHandler runs synchronously and needs to know which Cate portal
// the parent webContents belongs to so the new popup can be named "<Parent> #N".
// =============================================================================

import { ipcMain } from 'electron'
import { ORCH_PORTAL_WC_REGISTER } from '../../shared/ipc-channels'
import { windowFromEvent } from '../windowRegistry'
import * as registry from './registry'
import { setPopupParentResolver } from './popups'
import log from '../logger'

interface PortalWcEntry {
  windowId: number
  panelId: string
  /** Populated lazily — set to the latest known name from the registry when
   *  a popup parent-lookup happens. */
}

const byWcId = new Map<number, PortalWcEntry>()

export function registerPortalWcRouting(): void {
  ipcMain.on(ORCH_PORTAL_WC_REGISTER, (event, payload: { panelId: string; webContentsId: number; alive: boolean }) => {
    const win = windowFromEvent(event)
    if (!win) return
    if (!payload || typeof payload.panelId !== 'string' || typeof payload.webContentsId !== 'number') return
    if (payload.alive === false) {
      byWcId.delete(payload.webContentsId)
      return
    }
    byWcId.set(payload.webContentsId, { windowId: win.id, panelId: payload.panelId })
    log.debug('Portal wcMap: panel=%s wc=%d window=%d', payload.panelId, payload.webContentsId, win.id)
  })

  // Wire popups.ts so it can ask us "given parent webContents id, which Cate
  // portal panel is it?" — synchronously. We look up panelId here, then query
  // the registry for the live name/nodeId.
  setPopupParentResolver((parentWcId) => {
    const entry = byWcId.get(parentWcId)
    if (!entry) return null
    // Find the matching portal in the registry by panelId.
    const portal = (registry as any).findPortalByPanelId?.(entry.windowId, entry.panelId) as
      | { name: string; nodeId: string | null }
      | null
    const name = portal?.name ?? 'Portal'
    const nodeId = portal?.nodeId ?? null
    return { name, panelId: entry.panelId, nodeId, ownerWindowId: entry.windowId }
  })
}
