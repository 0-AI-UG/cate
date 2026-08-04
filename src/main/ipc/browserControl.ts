// =============================================================================
// browserControl — main-process half of the `cate.browser.*` agent surface.
//
// Browser automation is main-process-owned and implemented by agent-browser.
// The renderer resolves the visible Cate panel and forwards the method here;
// this module enforces guest ownership before the service can reach CDP.
//
// Every op re-uses the WEBVIEW_SCREENSHOT ownership rule: the target
// webContents must be a webview guest hosted by the CALLING window, so one
// window can never reach into another's pages.
// =============================================================================

import { BrowserWindow, ipcMain, webContents, type WebContents } from 'electron'
import log from '../logger'
import { wrapHandler } from './handlerError'
import { grantFileAccess } from './pathValidation'
import { BROWSER_CONTROL } from '../../shared/ipc-channels'
import { agentBrowserService } from '../browser/agentBrowser'
import { browserViewOwner } from '../browser/browserViewOwnership'

export interface BrowserControlRequest {
  op:
    | 'registerAgentBrowser'
    | 'agentBrowser'
    | 'downloads'
  webContentsId: number
  panelId?: string
  tabId?: string
  method?: string
  args?: Record<string, unknown>
}

/** Resolve the target guest, enforcing that it belongs to the calling window. */
export function resolveBrowserGuest(event: Electron.IpcMainInvokeEvent, webContentsId: number): WebContents | null {
  const wc = webContents.fromId(webContentsId)
  if (!wc || wc.isDestroyed()) return null
  const callerWin = BrowserWindow.fromWebContents(event.sender)
  const targetWin = BrowserWindow.fromWebContents(wc)
  const nativeOwner = browserViewOwner(webContentsId)
  if (!callerWin || ((!targetWin || targetWin.id !== callerWin.id) && nativeOwner?.id !== callerWin.id)) {
    const hostWc = wc.hostWebContents
    if (!hostWc || hostWc.id !== event.sender.id) {
      log.warn(`[browser:control] denied: webContentsId ${webContentsId} is not owned by the calling window`)
      return null
    }
  }
  return wc
}

// Downloads observed per guest webContents, newest last. `wait download` reads
// this; it is capped because nothing ever prunes it otherwise.
const DOWNLOADS_PER_GUEST = 20
const downloadsByWebContents = new Map<number, Array<{ url: string; filePath: string; state: string; at: number }>>()

/** Record downloads for a guest's session. Called by the browser panel host when
 *  a partition is first configured, so a download that happens before any agent
 *  asks about it is still observed. Safe to call repeatedly for one session. */
const watchedSessions = new WeakSet<Electron.Session>()
export function watchDownloadsForSession(session: Electron.Session): void {
  if (watchedSessions.has(session)) return
  watchedSessions.add(session)
  session.on('will-download', (_event, item, guest) => {
    const id = guest?.id
    if (id === undefined) return
    const list = downloadsByWebContents.get(id) ?? []
    const entry = { url: item.getURL(), filePath: '', state: 'started', at: Date.now() }
    list.push(entry)
    while (list.length > DOWNLOADS_PER_GUEST) list.shift()
    downloadsByWebContents.set(id, list)
    item.once('done', (_e, state) => {
      entry.state = state
      entry.filePath = item.getSavePath()
    })
  })
}

export function registerBrowserControlHandlers(): void {
  ipcMain.handle(BROWSER_CONTROL, wrapHandler(`[${BROWSER_CONTROL}]`, async (event, req: BrowserControlRequest) => {
    // Clipboard is app-global, but still gated on owning a real guest so the
    // permission story stays "you may drive THIS panel".
    const wc = resolveBrowserGuest(event, req.webContentsId)
    if (!wc) return { error: 'no-guest' }
    switch (req.op) {
      case 'downloads':
        return { downloads: downloadsByWebContents.get(req.webContentsId) ?? [] }

      case 'registerAgentBrowser': {
        if (!req.panelId || !req.tabId) return { error: 'browser-target-required' }
        await agentBrowserService.register(wc, req.panelId, req.tabId)
        return { ok: true }
      }

      case 'agentBrowser': {
        if (!req.method) return { error: 'browser-method-required' }
        const response = await agentBrowserService.execute(req.webContentsId, req.method, req.args ?? {})
        const callerWinId = BrowserWindow.fromWebContents(event.sender)?.id
        const result = response.result
        if (callerWinId !== undefined && result && typeof result === 'object') {
          const filePath = (result as { path?: unknown }).path
          if (typeof filePath === 'string') await grantFileAccess(callerWinId, filePath)
        }
        return response
      }

      default:
        return { error: 'unsupported-op' }
    }
  }))
}
