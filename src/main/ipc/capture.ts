import { app, BrowserWindow, ipcMain, nativeImage, webContents } from 'electron'
import fs from 'fs'
import path from 'path'
import log from '../logger'
import { wrapHandler } from './handlerError'
import { validatePath } from './pathValidation'
import { isLocalLocator } from '../runtime/locator'
import { configureBrowserProxy } from '../browserProxy'
import { windowFromEvent } from '../windowRegistry'
import { CAPTURE_PAGE, WEBVIEW_SCREENSHOT, BROWSER_SET_PROXY, NATIVE_FILE_DRAG } from '../../shared/ipc-channels'

export function registerCaptureHandlers(): void {
  // Capture page screenshot for panel previews
  ipcMain.handle(CAPTURE_PAGE, wrapHandler('[CAPTURE_PAGE]', async (event) => {
    const win = windowFromEvent(event)
    if (!win) return null
    const image = await win.webContents.capturePage()
    return image.toDataURL()
  }))

  // Capture a webview's visible content, save to Desktop, return dataUrl + path
  ipcMain.handle(WEBVIEW_SCREENSHOT, wrapHandler(`[${WEBVIEW_SCREENSHOT}]`, async (event, webContentsId: number) => {
    // Validate the webContentsId belongs to a webview guest of the calling window
    const callerWin = BrowserWindow.fromWebContents(event.sender)
    const wc = webContents.fromId(webContentsId)
    if (!wc || wc.isDestroyed()) return null
    // Ensure the target webContents belongs to the caller's window
    const targetWin = BrowserWindow.fromWebContents(wc)
    if (!callerWin || !targetWin || targetWin.id !== callerWin.id) {
      // For webview guests, the host window should match the caller
      const hostWc = wc.hostWebContents
      if (!hostWc || hostWc.id !== event.sender.id) {
        log.warn(`[webview:screenshot] Denied: webContentsId ${webContentsId} does not belong to calling window`)
        return null
      }
    }
    const image = await wc.capturePage()
    if (image.isEmpty()) return null

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const fileName = `screenshot-${timestamp}.png`
    const filePath = path.join(app.getPath('desktop'), fileName)
    await fs.promises.writeFile(filePath, image.toPNG())

    return { filePath, dataUrl: image.toDataURL() }
  }))

  // Configure a browser panel's per-partition proxy (issue #241). Awaited by the
  // renderer before it mounts the <webview> so the first request is proxied.
  ipcMain.handle(BROWSER_SET_PROXY, wrapHandler(`[${BROWSER_SET_PROXY}]`, async (_event, partition: string, proxyUrl?: string) => {
    await configureBrowserProxy(partition, proxyUrl)
  }))

  // Native file drag from renderer (for screenshot thumbnails etc.)
  ipcMain.handle(NATIVE_FILE_DRAG, wrapHandler('[NATIVE_FILE_DRAG]', async (event, filePath: string) => {
    // A remote path has no local file to export into a native OS drag — no-op
    // rather than mis-resolving the locator against the local filesystem.
    if (!isLocalLocator(filePath)) {
      return { ok: false, reason: 'remote' }
    }
    const validPath = validatePath(filePath)
    const win = windowFromEvent(event)
    if (!win) return
    // Create a small drag icon from the file
    const iconSize = 64
    const iconImage = nativeImage.createFromPath(validPath)
    const icon = iconImage.isEmpty() ? nativeImage.createEmpty() : iconImage.resize({ width: iconSize })
    event.sender.startDrag({ file: validPath, icon })
  }))
}
