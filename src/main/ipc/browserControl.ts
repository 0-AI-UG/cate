// Main-process control plane for Cate browser webviews. The renderer owns the
// visible tab and passes its exact guest id; this module validates ownership,
// binds an explicit logical identity, and delegates only to that guest's CDP
// session. There is no global target lookup and no second browser instance.

import { BrowserWindow, ipcMain, webContents, type WebContents } from 'electron'
import log from '../logger'
import { wrapHandler } from './handlerError'
import { grantFileAccess } from './pathValidation'
import { BROWSER_CONTROL } from '../../shared/ipc-channels'
import { browserRuntime, type BrowserTargetIdentity } from '../browser/browserRuntime'
import { actOnBrowserDownload, downloadsForWebContents, watchDownloadsForSession } from '../browser/browserDownloads'
import { authorizeBrowserUploadCommand } from '../browser/browserUpload'

export { watchDownloadsForSession }

export interface BrowserControlRequest extends Partial<BrowserTargetIdentity> {
  op: 'attach' | 'execute' | 'downloads' | 'downloadAction'
  webContentsId: number
  method?: string
  args?: Record<string, unknown>
}

/** Resolve the target guest, enforcing that it belongs to the calling window. */
export function resolveBrowserGuest(event: Electron.IpcMainInvokeEvent, webContentsId: number): WebContents | null {
  const contents = webContents.fromId(webContentsId)
  if (!contents || contents.isDestroyed() || contents.getType() !== 'webview') return null
  const host = contents.hostWebContents
  if (!host || host.id !== event.sender.id) {
    log.warn(`[browser:control] denied: webContentsId ${webContentsId} is not owned by the calling window`)
    return null
  }
  return contents
}

function identity(req: BrowserControlRequest): BrowserTargetIdentity | null {
  return req.workspaceId && req.panelId && req.tabId
    ? { workspaceId: req.workspaceId, panelId: req.panelId, tabId: req.tabId }
    : null
}

export function registerBrowserControlHandlers(): void {
  // Native user input wins over an in-flight agent action for this guest. The
  // guest preload sends no page data—only this cancellation signal.
  ipcMain.on('cate-browser-user-input', (event) => {
    if (event.sender.getType() === 'webview') browserRuntime.noteUserInput(event.sender.id)
  })
  ipcMain.handle(BROWSER_CONTROL, wrapHandler(`[${BROWSER_CONTROL}]`, async (event, req: BrowserControlRequest) => {
    const contents = resolveBrowserGuest(event, req.webContentsId)
    if (!contents) return { error: 'no-guest' }
    const target = identity(req)
    if (!target) return { error: 'browser-target-required' }

    if (req.op === 'attach') {
      watchDownloadsForSession(contents.session)
      await browserRuntime.attach(contents, target)
      return { ok: true }
    }
    if (req.op === 'downloads') {
      if (!browserRuntime.isRegistered(contents.id)) return { error: 'browser-target-not-registered' }
      return { downloads: downloadsForWebContents(contents.id) }
    }
    if (req.op === 'downloadAction') {
      if (!browserRuntime.isRegistered(contents.id)) return { error: 'browser-target-not-registered' }
      const downloadId = req.args?.downloadId
      const action = req.method
      if (typeof downloadId !== 'string' || !['cancel', 'open', 'show'].includes(action ?? '')) {
        return { error: 'invalid-download-action' }
      }
      return actOnBrowserDownload(contents.id, downloadId, action as 'cancel' | 'open' | 'show')
    }
    if (req.op === 'execute') {
      if (!req.method) return { error: 'browser-method-required' }
      const callerWindowId = BrowserWindow.fromWebContents(event.sender)?.id
      let args = req.args ?? {}
      if (req.method === 'command' && Array.isArray(args.command) && args.command[0] === 'upload') {
        if (callerWindowId === undefined) return { error: 'browser-upload-owner-required' }
        try {
          args = { ...args, command: await authorizeBrowserUploadCommand(args.command as string[], callerWindowId, target.workspaceId) }
        } catch (error) {
          return { error: error instanceof Error ? error.message : 'browser-upload-path-denied' }
        }
      }
      const response = await browserRuntime.execute(contents.id, target, req.method, args)
      const result = response.result
      if (callerWindowId !== undefined && result && typeof result === 'object') {
        const filePath = (result as { path?: unknown }).path
        if (typeof filePath === 'string') await grantFileAccess(callerWindowId, filePath)
      }
      return response
    }
    return { error: 'unsupported-op' }
  }))
}
