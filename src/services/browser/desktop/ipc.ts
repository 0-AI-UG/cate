// The desktop-main side of the page bridge (`BrowserPageBridge`). The
// renderer's browser view routes the runtime's surface requests here; every
// request names an opaque engine page handle, bound to its owning window.

import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  BROWSER_PAGE_CHANNELS,
  type BrowserChromeImport,
  type BrowserDownloadAction,
  type BrowserShortcutAction,
} from '../contract'
import { listChromePasswordProfiles, readChromePasswordCsv, readChromePasswords } from './chromeImport'
import type { GuestDownloads } from './downloads'
import type { createBrowserEngineHost } from './engine/host'

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

export interface BrowserIpcDeps {
  engine: Pick<ReturnType<typeof createBrowserEngineHost>, 'call' | 'owns'>
  downloads: GuestDownloads
  /** A private directory for staged uploads. */
  tempDir(): string
}

/** Forwards a browser key (pressed in a guest, or from the Browser menu) to a window. */
export function sendBrowserShortcut(host: WebContents, action: BrowserShortcutAction): void {
  try { host.send(BROWSER_PAGE_CHANNELS.shortcut, action) } catch { /* host gone */ }
}

/** Registers the page bridge IPC. Returns an unregister function. */
export function registerBrowserIpc(deps: BrowserIpcDeps): () => void {
  const { downloads, engine } = deps
  const handled: string[] = []
  const handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.handle(channel, handler)
    handled.push(channel)
  }
  const methods = new Map<string, string>([
    [BROWSER_PAGE_CHANNELS.attach, 'attach'], [BROWSER_PAGE_CHANNELS.execute, 'execute'],
    [BROWSER_PAGE_CHANNELS.protectPage, 'protectPage'], [BROWSER_PAGE_CHANNELS.preparePageDiscard, 'preparePageDiscard'],
    [BROWSER_PAGE_CHANNELS.restartIfHung, 'restartIfHung'], [BROWSER_PAGE_CHANNELS.fillCredential, 'fillCredential'],
    [BROWSER_PAGE_CHANNELS.answerDialog, 'answerDialog'], [BROWSER_PAGE_CHANNELS.screenshot, 'screenshot'],
    [BROWSER_PAGE_CHANNELS.download, 'download'],
  ])
  for (const [channel, method] of methods) handle(channel, (event, ...args) => {
    const id = typeof args[0] === 'number' ? args[0] : args[0]?.webContentsId
    if (!engine.owns(id, event.sender.id)) throw new Error('browser-surface-owner-mismatch')
    return engine.call('page', { method, args, ownerId: event.sender.id })
  })
  handle(BROWSER_PAGE_CHANNELS.downloadAction, async (event, id: number, downloadId: string, action: BrowserDownloadAction) => {
    if (typeof downloadId !== 'string' || !['cancel', 'open', 'show'].includes(action)) return { error: 'invalid-download-action' }
    const result = await downloads.act(event.sender.id, id, downloadId, action)
    if (result.error || action !== 'cancel') return result
    return engine.call('page', { method: 'downloadAction', args: [id, downloadId, action], ownerId: event.sender.id })
  })
  handle(BROWSER_PAGE_CHANNELS.readDownload, (event, id: number, downloadId: string) => {
    if (typeof downloadId !== 'string') return null
    return downloads.read(event.sender.id, id, downloadId)
  })

  handle(BROWSER_PAGE_CHANNELS.stageUpload, async (_event, name: string, bytes: Uint8Array) => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('browser-upload-too-large')
    const dir = path.join(deps.tempDir(), 'uploads', randomUUID())
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, path.basename(String(name || 'upload')))
    await fs.promises.writeFile(file, bytes, { mode: 0o600 })
    return file
  })

  handle(BROWSER_PAGE_CHANNELS.chromeProfiles, async () => ({
    directImportSupported: process.platform === 'darwin',
    profiles: await listChromePasswordProfiles(),
  }))

  handle(BROWSER_PAGE_CHANNELS.readChromePasswords, (_event, profileId: string) => readChromePasswords(String(profileId)))

  handle(BROWSER_PAGE_CHANNELS.readChromePasswordCsv, async (event): Promise<BrowserChromeImport> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Import Chrome passwords',
      properties: ['openFile'],
      filters: [{ name: 'Chrome password export', extensions: ['csv'] }],
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return { canceled: true, credentials: [], skipped: 0 }
    return readChromePasswordCsv(result.filePaths[0])
  })

  return () => {
    for (const channel of handled) ipcMain.removeHandler(channel)
  }
}
