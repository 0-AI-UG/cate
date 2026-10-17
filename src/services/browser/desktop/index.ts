// services/browser desktop side (architecture 10.2): the page driver over
// guest webContents, guest downloads, the Chrome password import,
// passkeys and the page bridge IPC. The desktop shell builds it once in main.

import type { WebContents } from 'electron'
import { BROWSER_PAGE_CHANNELS } from '../contract'
import { GuestDialogs } from './dialogs'
import { GuestDownloads } from './downloads'
import { registerBrowserIpc } from './ipc'
import { PageDriverRegistry } from './pageDriver'
import { registerBrowserPasskeys } from './passkeys'

export { PageDriver, PageDriverRegistry, createPageDriver, isAgentKeyInput, type PageDriverOptions } from './pageDriver'
export { GuestDownloads, type GuestDownloadsDeps } from './downloads'
export { GuestDialogs, registerGuestDialogs, type BrowserDialogAnswer } from './dialogs'
export { registerBrowserIpc, hostedGuest, sendOpenTabRequest, sendBrowserShortcut, type BrowserIpcDeps } from './ipc'
export { registerBrowserPasskeys, passkeysAddonPath, type BrowserPasskeysDeps } from './passkeys'
export { listChromePasswordProfiles, readChromePasswords, readChromePasswordCsv, decryptChromePassword } from './chromeImport'
export { flattenScreenshotPng } from './screenshotPng'
export { installPersistentSessionTracking, flushPersistentSessions } from './persistentSessions'
export { workspacePartition } from '../contract'

export interface BrowserDesktopOptions {
  /** Where guest downloads are saved on this machine. */
  downloadDir(): string
  /** A private directory for staged uploads. */
  tempDir(): string
  /** Loads the native passkeys addon (macOS only; the shell decides). */
  passkeys: boolean
}

export interface BrowserDesktop {
  drivers: PageDriverRegistry
  downloads: GuestDownloads
  /** Whether the native passkey bridge loaded: declare `passkeys` only then. */
  passkeysAvailable: boolean
  dispose(): void
}

/** Builds and registers the browser desktop side in main. */
export function createBrowserDesktop(options: BrowserDesktopOptions): BrowserDesktop {
  const dialogs = new GuestDialogs()
  const drivers = new PageDriverRegistry({ dialogs })
  const downloads = new GuestDownloads({
    downloadDir: options.downloadDir,
    notify: (host: WebContents, event) => host.send(BROWSER_PAGE_CHANNELS.downloads, event),
  })
  const unregister = registerBrowserIpc({ drivers, downloads, dialogs, tempDir: options.tempDir })
  const passkeysAvailable = options.passkeys
    ? registerBrowserPasskeys({ isRegistered: (id) => drivers.isRegistered(id) }).available
    : false
  return { drivers, downloads, passkeysAvailable, dispose: unregister }
}
