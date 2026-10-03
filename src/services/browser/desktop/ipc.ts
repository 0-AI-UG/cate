// The desktop-main side of the page bridge (`BrowserPageBridge`). The
// renderer's browser view routes the runtime's surface requests here; every
// request names a guest by webContents id, and only the window hosting that
// guest may use it.

import { BrowserWindow, dialog, ipcMain, webContents, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '@kernel/log/contract'
import {
  BROWSER_GUEST_CHANNELS,
  BROWSER_PAGE_CHANNELS,
  type BrowserChromeImport,
  type BrowserCodeCall,
  type BrowserDownloadAction,
  type BrowserGuestRef,
  type BrowserShortcutAction,
} from '../contract'
import { listChromePasswordProfiles, readChromePasswordCsv, readChromePasswords } from './chromeImport'
import type { BrowserCodeSessions } from './codeSessions'
import type { GuestDownloads } from './downloads'
import type { PageDriverRegistry } from './pageDriver'
import { flattenScreenshotPng } from './screenshotPng'

const log = createLogger('browser')
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

export interface BrowserIpcDeps {
  drivers: PageDriverRegistry
  codeSessions: BrowserCodeSessions
  downloads: GuestDownloads
  /** A private directory for staged uploads. */
  tempDir(): string
}

/** The guest `webContentsId`, when it is a webview hosted by the caller. */
export function hostedGuest(event: IpcMainInvokeEvent, webContentsId: unknown): WebContents | null {
  if (typeof webContentsId !== 'number') return null
  const contents = webContents.fromId(webContentsId)
  if (!contents || contents.isDestroyed() || contents.getType() !== 'webview') return null
  if (contents.hostWebContents?.id !== event.sender.id) {
    log.warn('denied: webContents %d is not hosted by the calling window', webContentsId)
    return null
  }
  return contents
}

const identity = (guest: BrowserGuestRef) => ({ panelId: guest.panelId, tabId: guest.tabId })

/** Tells the window hosting `guest` that the page asked for a new tab. The
 *  shell's webview hardening calls it from the guest's window-open handler. */
export function sendOpenTabRequest(guest: WebContents, url: string): void {
  try { guest.hostWebContents?.send(BROWSER_PAGE_CHANNELS.openTab, { openerWebContentsId: guest.id, url }) } catch { /* host gone */ }
}

/** Forwards a browser key (pressed in a guest, or from the Browser menu) to a window. */
export function sendBrowserShortcut(host: WebContents, action: BrowserShortcutAction): void {
  try { host.send(BROWSER_PAGE_CHANNELS.shortcut, action) } catch { /* host gone */ }
}

/** Registers the page bridge IPC. Returns an unregister function. */
export function registerBrowserIpc(deps: BrowserIpcDeps): () => void {
  const { drivers, codeSessions, downloads } = deps
  const handled: string[] = []
  const handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.handle(channel, handler)
    handled.push(channel)
  }
  const pendingCalls = new Map<string, { host: number; resolve(value: unknown): void; reject(error: Error): void }>()

  // Native user input wins over an in-flight agent action for this guest. The
  // guest preload sends no page data, only this signal.
  const onUserInput = (event: Electron.IpcMainEvent) => {
    if (event.sender.getType() === 'webview') drivers.noteUserInput(event.sender.id)
  }
  ipcMain.on(BROWSER_GUEST_CHANNELS.userInput, onUserInput)

  handle(BROWSER_PAGE_CHANNELS.attach, async (event, guest: BrowserGuestRef) => {
    const contents = hostedGuest(event, guest?.webContentsId)
    if (!contents) throw new Error('no-guest')
    downloads.watch(contents.session)
    await drivers.attach(contents, identity(guest))
  })

  handle(BROWSER_PAGE_CHANNELS.execute, async (event, guest: BrowserGuestRef, method: string, args: Record<string, unknown>) => {
    const contents = hostedGuest(event, guest?.webContentsId)
    if (!contents) return { error: 'no-guest' }
    if (typeof method !== 'string' || !method) return { error: 'browser-method-required' }
    return drivers.execute(contents.id, identity(guest), method, args && typeof args === 'object' ? args : {})
  })

  handle(BROWSER_PAGE_CHANNELS.download, async (event, guest: BrowserGuestRef, url: string) => {
    const contents = hostedGuest(event, guest?.webContentsId)
    if (!contents) throw new Error('no-guest')
    if (!drivers.isRegistered(contents.id)) throw new Error('browser-target-not-registered')
    if (typeof url !== 'string' || !url) throw new Error('url-required')
    contents.downloadURL(url)
  })

  handle(BROWSER_PAGE_CHANNELS.downloadAction, (event, webContentsId: number, downloadId: string, action: BrowserDownloadAction) => {
    if (typeof downloadId !== 'string' || !['cancel', 'open', 'show'].includes(action)) return { error: 'invalid-download-action' }
    return downloads.act(event.sender.id, webContentsId, downloadId, action)
  })

  handle(BROWSER_PAGE_CHANNELS.readDownload, (event, webContentsId: number, downloadId: string) => {
    if (typeof downloadId !== 'string') return null
    return downloads.read(event.sender.id, webContentsId, downloadId)
  })

  handle(BROWSER_PAGE_CHANNELS.fillCredential, (event, webContentsId: number, targetId: string, credential: { username: string; password: string }) => {
    const contents = hostedGuest(event, webContentsId)
    if (!contents) return { error: 'no-guest' }
    if (typeof targetId !== 'string' || typeof credential?.password !== 'string') return { error: 'invalid-credential' }
    return drivers.fillCredential(contents.id, targetId, { username: String(credential.username ?? ''), password: credential.password })
  })

  handle(BROWSER_PAGE_CHANNELS.stageUpload, async (_event, name: string, bytes: Uint8Array) => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('browser-upload-too-large')
    const dir = path.join(deps.tempDir(), 'uploads', randomUUID())
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, path.basename(String(name || 'upload')))
    await fs.promises.writeFile(file, bytes, { mode: 0o600 })
    return file
  })

  handle(BROWSER_PAGE_CHANNELS.screenshot, async (event, webContentsId: number) => {
    const contents = hostedGuest(event, webContentsId)
    if (!contents) return null
    const image = await contents.capturePage()
    if (image.isEmpty()) return null
    const png = flattenScreenshotPng(image.toPNG())
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}` }
  })

  handle(BROWSER_PAGE_CHANNELS.runCode, (event, request: { key: string; cellId: string; code: string; deadlineMs: number }) => {
    const host = event.sender
    // Each cua call goes to the hosting renderer, which passes it to the runtime.
    const invoke = (method: string, args: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
      if (host.isDestroyed()) return reject(new Error('The window running this cell closed'))
      const requestId = randomUUID()
      pendingCalls.set(requestId, { host: host.id, resolve, reject })
      const call: BrowserCodeCall = { cellId: request.cellId, method: method.replace(/^cate\.browser\./, ''), args }
      host.send(BROWSER_PAGE_CHANNELS.codeCall, { requestId, call })
    })
    return codeSessions.run(`${host.id}:${request.key}`, request.code, invoke, { cellId: request.cellId, deadlineMs: request.deadlineMs })
  })

  handle(BROWSER_PAGE_CHANNELS.codeCallReply, (event, reply: { requestId: string; result?: unknown; error?: string }) => {
    const pending = pendingCalls.get(reply?.requestId)
    if (!pending || pending.host !== event.sender.id) return
    pendingCalls.delete(reply.requestId)
    if (reply.error !== undefined) pending.reject(new Error(reply.error))
    else pending.resolve(reply.result)
  })

  handle(BROWSER_PAGE_CHANNELS.resetCode, (event, key: string) => {
    codeSessions.reset(`${event.sender.id}:${key}`)
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
    ipcMain.removeListener(BROWSER_GUEST_CHANNELS.userInput, onUserInput)
    for (const pending of pendingCalls.values()) pending.reject(new Error('browser-ipc-closed'))
    pendingCalls.clear()
    codeSessions.dispose()
  }
}
