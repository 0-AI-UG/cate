// The browser panel's session channel: snapshot and ops (architecture 10.2,
// 11.3). The session holds tabs, URLs, titles and navigation state; each
// client loads the page itself and every client follows the session URL.
// Which tab a client shows is that client's own; `activeTabId` is the tab the
// last selection named, the one `cate.browser.*` acts on.

import type { BrowserDownloadState, BrowserViewport } from '@services/browser/contract'
import type { AgentCursorKind } from './agentCursor'

export type { BrowserViewport }

export type BrowserTab = {
  id: string
  url: string
  title: string
  /** Favicon URL the page reported; null until it does. */
  favicon: string | null
  /** Pinned tabs sort left, render compact and resist accidental close. */
  pinned: boolean
  /** Counts URL changes. A client loads `url` when this moves and the change
   *  did not come from its own webview (`navSource`). */
  nav: number
  /** The client whose webview reported the URL; null for an explicit
   *  navigation every client loads (address bar, `cate.browser.goto`). */
  navSource: string | null
}

export type BrowserDownload = {
  id: string
  url: string
  filename: string
  filePath: string
  state: BrowserDownloadState
  receivedBytes: number
  totalBytes: number
  at: number
}

/** An agent cursor event as the snapshot carries it (JSON: null, not absent). */
export type BrowserAgentCursorEvent = {
  kind: AgentCursorKind
  label: string
  x: number | null
  y: number | null
  toX: number | null
  toY: number | null
}

export type BrowserAgentCursor = {
  event: BrowserAgentCursorEvent
  /** Counts events so a repeated one replays. */
  serial: number
}

export type BrowserSnapshot = {
  tabs: BrowserTab[]
  /** The tab the last selection named (a person's, a caller's, a new tab):
   *  the one `cate.browser.*` acts on. A person picking another tab cancels
   *  page work bound to this one. */
  activeTabId: string
  /** The client whose selection made `activeTabId` active; null for a
   *  selection every client shows (a `cate.browser.*` caller's). A client
   *  follows only its own and null ones. */
  activeSource: string | null
  viewport: BrowserViewport
  /** Page zoom factor. */
  zoom: number
  /** Navigation state of the active tab, as the last reporting client saw it. */
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  loadError: string | null
  crashed: boolean
  /** The panel's downloads (from `browserData`), newest first. */
  downloads: BrowserDownload[]
  agentCursor: BrowserAgentCursor | null
}

export type BrowserHistoryAction = 'back' | 'forward' | 'reload' | 'reloadHard'

export type BrowserOp =
  /** Address bar input: a URL, an internal page or a search. */
  | { kind: 'navigate'; input: string; tabId?: string }
  | { kind: 'newTab'; url?: string }
  | { kind: 'closeTab'; tabId: string }
  | { kind: 'selectTab'; tabId: string }
  | { kind: 'pin'; tabId: string; pinned?: boolean }
  /** A client's webview navigated (in page or not). */
  | { kind: 'reportNavigation'; tabId: string; url: string; title?: string; inPage?: boolean; canGoBack: boolean; canGoForward: boolean }
  | { kind: 'reportTitle'; tabId: string; title: string }
  | { kind: 'reportFavicon'; tabId: string; favicon: string }
  /** Loading, a main-frame load error, or a crashed guest. */
  /** Load and history state of the reporting client's page (history also
   *  from clients following a navigation, which report no URL). */
  | { kind: 'reportLoad'; tabId: string; loading?: boolean; loadError?: string | null; crashed?: boolean; canGoBack?: boolean; canGoForward?: boolean }
  /** Back, forward or reload on the driving client's page (palette commands). */
  | { kind: 'history'; action: BrowserHistoryAction; tabId?: string }
  | { kind: 'setZoom'; zoom: number }
  | { kind: 'stepZoom'; direction: 1 | -1 }
  | { kind: 'setViewport'; viewport: BrowserViewport }
  /** User input takes the page back from the agent. */
  | { kind: 'releaseAgentCursor' }

/** Page zoom steps, as in Chrome. */
export const BROWSER_ZOOM_FACTORS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const

export const COMPACT_VIEWPORT: BrowserViewport = { preset: 'compact' }

/** The record fields of a browser panel: the URL it opened on, then its
 *  active URL, kept by the session for `describe` and the palette. */
export type BrowserRecordFields = { url?: string }
