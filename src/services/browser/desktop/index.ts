// services/browser desktop side (architecture 10.2): the page driver over
// guest webContents, guest downloads, the Chrome password import,
// passkeys and the page bridge IPC. The desktop shell builds it once in main.

import { BrowserWindow, dialog, webContents } from 'electron'
import type { createBrowserEngineHost } from './engine/host'
import { BROWSER_PAGE_CHANNELS } from '../contract'
import { GuestDownloads } from './downloads'
import { registerBrowserIpc } from './ipc'
import { createEnginePasskeys } from './passkeys'

export { PageDriver, PageDriverRegistry, createPageDriver, type PageDriverOptions } from './pageDriver'
export { GuestDownloads, type GuestDownloadsDeps } from './downloads'
export { GuestDialogs, registerGuestDialogs, type BrowserDialogAnswer } from './dialogs'
export { registerBrowserIpc, sendBrowserShortcut, type BrowserIpcDeps } from './ipc'
export { passkeysAddonPath } from './passkeys'
export { listChromePasswordProfiles, readChromePasswords, readChromePasswordCsv, decryptChromePassword } from './chromeImport'
export { flattenScreenshotPng } from './screenshotPng'
export { installPersistentSessionTracking, flushPersistentSessions } from './persistentSessions'
export { workspacePartition } from '../contract'

export interface BrowserDesktopOptions {
  engine: ReturnType<typeof createBrowserEngineHost>
  /** Where guest downloads are saved on this machine. */
  downloadDir(): string
  /** A private directory for staged uploads. */
  tempDir(): string
  /** Loads the native passkeys addon (macOS only; the shell decides). */
  passkeys: boolean
}

export interface BrowserDesktop {
  downloads: GuestDownloads
  /** Whether the native passkey bridge loaded: declare `passkeys` only then. */
  passkeysAvailable: boolean
  dispose(): void
}

/** Builds and registers the browser desktop side in main. */
export function createBrowserDesktop(options: BrowserDesktopOptions): BrowserDesktop {
  const downloads = new GuestDownloads({
    downloadDir: options.downloadDir,
    owner: () => undefined,
    notify: (host, event) => host.send(BROWSER_PAGE_CHANNELS.downloads, event),
  })
  options.engine.onEvent((ownerId, channel, payload) => {
    if (channel !== BROWSER_PAGE_CHANNELS.downloads) return
    const owner = webContents.fromId(ownerId)
    if (owner && !owner.isDestroyed()) downloads.adopt(owner, payload.webContentsId, payload.downloads)
  })
  options.engine.onExit(() => downloads.interruptRemote())
  const unregister = registerBrowserIpc({ downloads, tempDir: options.tempDir, engine: options.engine })
  options.engine.handle('chooseFiles', async args => {
    const contents = options.engine.owner(args.webContentsId)
    const owner = contents && BrowserWindow.fromWebContents(contents)
    if (!owner || owner.isDestroyed() || !owner.isVisible() || !owner.isFocused()) return null
    const extensions = String(args.accept ?? '').split(',').map(value => value.trim()).filter(value => /^\.[a-z0-9]+$/i.test(value)).map(value => value.slice(1))
    const result = await dialog.showOpenDialog(owner, {
      properties: [args.directory ? 'openDirectory' : 'openFile', ...(args.multiple ? ['multiSelections' as const] : [])],
      ...(extensions.length ? { filters: [{ name: 'Allowed files', extensions }, { name: 'All files', extensions: ['*'] }] } : {}),
    })
    return result.canceled ? null : result.filePaths
  })
  let passkeysAvailable = false
  if (options.passkeys) {
    const engine = options.engine
    const passkeys = createEnginePasskeys({ owner: id => {
      const owner = engine.owner(id)
      return owner ? BrowserWindow.fromWebContents(owner) : null
    } })
    engine.handle('passkey', args => passkeys.request(args.webContentsId, args.origin, args.input))
    engine.handle('cancelPasskey', args => passkeys.cancel(args.webContentsId, args.id))
    engine.onExit(() => passkeys.cancelAll())
    engine.setPasskeysAvailable(passkeys.available)
    passkeysAvailable = passkeys.available
  }
  return { downloads, passkeysAvailable, dispose: unregister }
}

export { createBrowserEngineHost } from './engine/host'
export { runBrowserEngine } from './engine/entry'
export { registerBrowserEngineIpc } from './engine/ipc'
