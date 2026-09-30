// services/browser desktop side (architecture 10.2): the page driver over
// guest webContents, code cells, guest downloads, the Chrome password import,
// passkeys and the page bridge IPC. The desktop shell builds it once in main.

import type { WebContents } from 'electron'
import { BROWSER_PAGE_CHANNELS } from '../contract'
import { BrowserCodeSessions } from './codeSessions'
import { CodeCellRegistry } from './codeCells'
import { GuestDownloads } from './downloads'
import { registerBrowserIpc } from './ipc'
import { PageDriverRegistry } from './pageDriver'
import { registerBrowserPasskeys } from './passkeys'

export { PageDriver, PageDriverRegistry, createPageDriver, type PageDriverOptions } from './pageDriver'
export { BrowserCodeSessions, type BrowserCodeSessionsOptions, type RunCodeOptions } from './codeSessions'
export { CodeCellRegistry } from './codeCells'
export { GuestDownloads, type GuestDownloadsDeps } from './downloads'
export { registerBrowserIpc, hostedGuest, sendOpenTabRequest, sendBrowserShortcut, type BrowserIpcDeps } from './ipc'
export { registerBrowserPasskeys, passkeysAddonPath, type BrowserPasskeysDeps } from './passkeys'
export { listChromePasswordProfiles, readChromePasswords, readChromePasswordCsv, decryptChromePassword } from './chromeImport'
export { flattenScreenshotPng } from './screenshotPng'
export { installPersistentSessionTracking, flushPersistentSessions } from './persistentSessions'
export { workspacePartition } from '../contract'

export interface BrowserDesktopOptions {
  /** The built `preload/codeCell.ts` (the code-cell sandbox preload). */
  codeCellPreload: string
  /** Where guest downloads are saved on this machine. */
  downloadDir(): string
  /** A private directory for staged uploads and screenshots. */
  tempDir(): string
  /** Loads the native passkeys addon (macOS only; the shell decides). */
  passkeys: boolean
}

export interface BrowserDesktop {
  drivers: PageDriverRegistry
  codeSessions: BrowserCodeSessions
  downloads: GuestDownloads
  /** Whether the native passkey bridge loaded: declare `passkeys` only then. */
  passkeysAvailable: boolean
  dispose(): void
}

/** Builds and registers the browser desktop side in main. */
export function createBrowserDesktop(options: BrowserDesktopOptions): BrowserDesktop {
  const cells = new CodeCellRegistry()
  const drivers = new PageDriverRegistry({ checkCell: cells.assert })
  const codeSessions = new BrowserCodeSessions({ preloadPath: options.codeCellPreload, cells })
  const downloads = new GuestDownloads({
    downloadDir: options.downloadDir,
    notify: (host: WebContents, event) => host.send(BROWSER_PAGE_CHANNELS.downloads, event),
  })
  const unregister = registerBrowserIpc({ drivers, codeSessions, downloads, tempDir: options.tempDir })
  const passkeysAvailable = options.passkeys
    ? registerBrowserPasskeys({ isRegistered: (id) => drivers.isRegistered(id) }).available
    : false
  return { drivers, codeSessions, downloads, passkeysAvailable, dispose: unregister }
}
