// =============================================================================
// Popup registry — tracks `window.open()` popups spawned from Cate's portal
// webviews so the `cate portal` CLI can drive them as `[Parent] #2` (etc.).
//
// Flow:
//   1. `webSecurity.ts` `setWindowOpenHandler` for a webview guest sees an
//      open request and calls `registerPopupForGuest(parentWcId, url)`.
//   2. We return `{ action: 'allow', ... }` so Electron creates a real
//      BrowserWindow.
//   3. `did-create-window` on the parent gives us the new BrowserWindow;
//      we call `attachPopupWindow(parentWcId, win)` to wire it in.
//   4. The popup's webContents is added to the per-window portal list under
//      the name `[Parent] #N` and reuses the parent portal's canvas node id
//      for auth purposes (so the agent that could drive the parent can drive
//      the popup).
//   5. When the popup closes or its webContents is destroyed, we clean up.
//
// Auth model: a popup inherits the parent portal's node id, meaning anyone
// connected to the parent on the canvas is implicitly connected to the
// popup. This matches Maestri's behavior — popups are transient extensions
// of the parent, not first-class canvas citizens.
// =============================================================================

import { BrowserWindow, type WebContents } from 'electron'
import log from '../logger'

interface PopupRecord {
  /** webContents id of the popup window. */
  webContentsId: number
  /** The BrowserWindow Electron created for the popup. */
  win: BrowserWindow
  /** Display name — e.g. "Docs #2". */
  name: string
  /** webContents id of the parent webview guest. */
  parentWcId: number
  /** Cate panelId of the parent portal (or null if it's a popup-of-a-popup
   *  whose immediate parent wasn't a Cate portal — rare). */
  parentPanelId: string | null
  /** Canvas node id of the parent — used for the auth check. Popups inherit
   *  this so connections to the parent flow through. */
  parentNodeId: string | null
  /** Which BrowserWindow id owns the parent portal (the Cate window the
   *  popup logically belongs to). */
  ownerWindowId: number
}

const popups = new Map<number /* webContentsId */, PopupRecord>()
const counterByParent = new Map<string /* parent name */, number>()

/** Optional resolver provided by the orchestrator at boot. Given a parent
 *  webContents id, returns the parent portal's identity (name, panelId,
 *  nodeId, owner window). Without this we can't name popups; webSecurity
 *  falls back to a generic "Popup #N" name. */
type ParentResolver = (parentWcId: number) => null | {
  name: string
  panelId: string
  nodeId: string | null
  ownerWindowId: number
}
let parentResolver: ParentResolver | null = null
export function setPopupParentResolver(fn: ParentResolver): void {
  parentResolver = fn
}

function allocateName(parentName: string): string {
  // Maestri convention: "[Parent] #2", "[Parent] #3", ... but we use plain
  // "<Parent> #N" because the brackets read weirdly in Cate's tab UI. Either
  // form is fine — the CLI accepts whatever string is in `cate list`.
  const next = (counterByParent.get(parentName) ?? 1) + 1
  counterByParent.set(parentName, next)
  return `${parentName} #${next}`
}

/** Called from webSecurity.setWindowOpenHandler. The webview guest is asking
 *  to open `url`. We return whatever Electron should do with the request;
 *  the actual popup is wired up in `attachPopupWindow` after Electron has
 *  created the new BrowserWindow. */
export function describePopupParent(parentWcId: number): { parentName: string; record: ReturnType<ParentResolver> } | null {
  if (!parentResolver) return null
  const parent = parentResolver(parentWcId)
  if (!parent) return null
  return { parentName: parent.name, record: parent }
}

/** Called from `did-create-window` on the parent webview. Adopts the new
 *  BrowserWindow as a Cate popup portal. */
export function attachPopupWindow(parentWcId: number, win: BrowserWindow): void {
  const parent = parentResolver?.(parentWcId) ?? null
  const parentName = parent?.name ?? 'Popup'
  const name = allocateName(parentName)

  const wc = win.webContents
  const record: PopupRecord = {
    webContentsId: wc.id,
    win,
    name,
    parentWcId,
    parentPanelId: parent?.panelId ?? null,
    parentNodeId: parent?.nodeId ?? null,
    ownerWindowId: parent?.ownerWindowId ?? -1,
  }
  popups.set(wc.id, record)
  log.info('Popups: tracking %s (wc=%d, parent wc=%d)', name, wc.id, parentWcId)

  const cleanup = () => {
    if (popups.delete(wc.id)) {
      log.info('Popups: closed %s', name)
    }
  }
  win.once('closed', cleanup)
  wc.once('destroyed', cleanup)
}

/** Find a popup by display name in a given owner window. */
export function findPopupByName(ownerWindowId: number, name: string): PopupRecord | null {
  const needle = name.trim().toLowerCase()
  for (const r of popups.values()) {
    if (r.ownerWindowId === ownerWindowId && r.name.toLowerCase() === needle) return r
  }
  return null
}

/** All popups currently owned by a window — used to enrich the portal list. */
export function listPopupsForWindow(ownerWindowId: number): PopupRecord[] {
  const out: PopupRecord[] = []
  for (const r of popups.values()) {
    if (r.ownerWindowId === ownerWindowId) out.push(r)
  }
  return out
}

/** Drop all popups belonging to a window (window close). */
export function clearPopupsForWindow(ownerWindowId: number): void {
  for (const [id, r] of popups) {
    if (r.ownerWindowId !== ownerWindowId) continue
    try { if (!r.win.isDestroyed()) r.win.close() } catch { /* fine */ }
    popups.delete(id)
  }
}

/** Drop a single popup by webContents id. */
export function deregisterPopup(wcId: number): void {
  popups.delete(wcId)
}

/** Look up the live webContents for a popup by name. */
export function popupWebContents(name: string, ownerWindowId: number): WebContents | null {
  const r = findPopupByName(ownerWindowId, name)
  if (!r) return null
  if (r.win.isDestroyed() || r.win.webContents.isDestroyed()) {
    popups.delete(r.webContentsId)
    return null
  }
  return r.win.webContents
}
