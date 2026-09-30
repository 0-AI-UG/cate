// The desktop page bridge: what the desktop shell's preload hands the renderer
// for browser views. Webviews live in the renderer, but their webContents, the
// page driver, code cells, downloads and the Chrome password import live in
// desktop main. No workspace work crosses it: passwords come from the runtime
// through `browserData`, and the view hands main only what one page needs.

import type { BrowserCodeResult, BrowserDriverResult, BrowserPageIdentity } from './automation'
import type { BrowserCredentialImport, BrowserDownloadEntry } from './types'

/** A guest webContents this window hosts, bound to its panel tab. */
export interface BrowserGuestRef extends BrowserPageIdentity {
  webContentsId: number
}

export interface BrowserChromeProfile {
  id: string
  appName: string
  profileName: string
}

export interface BrowserChromeProfiles {
  /** Reading a Chrome profile directly works on macOS only; elsewhere, CSV. */
  directImportSupported: boolean
  profiles: BrowserChromeProfile[]
}

/** Rows read from Chrome, handed to `browserData.importPasswords`. */
export interface BrowserChromeImport {
  canceled?: boolean
  credentials: BrowserCredentialImport[]
  skipped: number
}

/** A `cua.*` call of a running code cell, for the renderer to pass to the
 *  runtime (`browserCode.call`). */
export interface BrowserCodeCall {
  cellId: string
  method: string
  args: Record<string, unknown>
}

export type BrowserDownloadAction = 'cancel' | 'open' | 'show'

export type BrowserShortcutAction = 'reload' | 'reloadHard' | 'back' | 'forward' | 'focusUrl'

export interface BrowserPageBridge {
  /** Binds the page driver to a guest (after its `dom-ready`). */
  attach(guest: BrowserGuestRef): Promise<void>
  /** Runs one page-driver method on a bound guest. */
  execute(guest: BrowserGuestRef, method: string, args: Record<string, unknown>): Promise<BrowserDriverResult>
  /** Downloads `url` through the guest's partition. */
  download(guest: BrowserGuestRef, url: string): Promise<void>
  downloadAction(webContentsId: number, downloadId: string, action: BrowserDownloadAction): Promise<{ ok?: true; error?: string }>
  /** The bytes of a completed download, for the runtime's copy; null when it
   *  is gone or too large. */
  readDownload(webContentsId: number, downloadId: string): Promise<Uint8Array | null>
  /** Fills a credential into the password field the guest marked `targetId`. */
  fillCredential(webContentsId: number, targetId: string, credential: { username: string; password: string }): Promise<{ ok?: true; error?: string }>
  /** Writes bytes for a file input to a private temp file; returns its path. */
  stageUpload(name: string, bytes: Uint8Array): Promise<string>
  /** Captures the guest's page as a PNG. */
  screenshot(webContentsId: number): Promise<{ dataUrl: string; filePath: string } | null>

  /** Runs a cell in this client's isolated code session for `key`. */
  runCode(request: { key: string; cellId: string; code: string; deadlineMs: number }): Promise<BrowserCodeResult>
  resetCode(key: string): Promise<void>
  /** Main forwards each `cua.*` call of a running cell; the handler answers it. */
  onCodeCall(handler: (call: BrowserCodeCall) => Promise<unknown>): () => void

  /** Downloads of the guests this window hosts. */
  onDownloads(listener: (event: { webContentsId: number; downloads: BrowserDownloadEntry[] }) => void): () => void
  /** A page asked for a new window (`window.open`, target=_blank). */
  onOpenTab(listener: (event: { openerWebContentsId: number; url: string }) => void): () => void
  /** Browser keys pressed while a guest had focus, or the Browser menu. */
  onShortcut(listener: (action: BrowserShortcutAction) => void): () => void

  chromeProfiles(): Promise<BrowserChromeProfiles>
  readChromePasswords(profileId: string): Promise<BrowserChromeImport>
  /** Asks for a Chrome password export CSV and reads it. */
  readChromePasswordCsv(): Promise<BrowserChromeImport>
}

/** IPC channel names between the shell preload and desktop main. */
export const BROWSER_PAGE_CHANNELS = {
  attach: 'cate:browser-page:attach',
  execute: 'cate:browser-page:execute',
  download: 'cate:browser-page:download',
  downloadAction: 'cate:browser-page:download-action',
  readDownload: 'cate:browser-page:read-download',
  fillCredential: 'cate:browser-page:fill-credential',
  stageUpload: 'cate:browser-page:stage-upload',
  screenshot: 'cate:browser-page:screenshot',
  runCode: 'cate:browser-page:run-code',
  resetCode: 'cate:browser-page:reset-code',
  codeCall: 'cate:browser-page:code-call',
  codeCallReply: 'cate:browser-page:code-call-reply',
  downloads: 'cate:browser-page:downloads',
  openTab: 'cate:browser-page:open-tab',
  shortcut: 'cate:browser-page:shortcut',
  chromeProfiles: 'cate:browser-page:chrome-profiles',
  readChromePasswords: 'cate:browser-page:chrome-passwords',
  readChromePasswordCsv: 'cate:browser-page:chrome-password-csv',
} as const

/** Channels the guest preload uses. Kept literal in the preload itself, which
 *  must bundle self-contained. */
export const BROWSER_GUEST_CHANNELS = {
  passwordFocus: 'cate-browser-password-focus',
  passwordSubmit: 'cate-browser-password-submit',
  userInput: 'cate-browser-user-input',
  automationInput: 'cate-browser-automation-input',
} as const

/** The partition of a workspace's webviews: `persist:ws-<runtimeId>`. */
export function workspacePartition(runtimeId: string): string {
  return `persist:ws-${runtimeId}`
}
