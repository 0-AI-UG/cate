// Browser data shapes shared by the runtime and every client.

/** The start-page sentinel URL a new tab shows. */
export const BROWSER_NEW_TAB_URL = 'cate://newtab'

/** One history entry, deduplicated by URL. */
export interface BrowserHistoryEntry {
  url: string
  title: string
  lastVisited: number
  visitCount: number
}

/** A bookmark, deduplicated by URL. */
export interface BrowserBookmark {
  url: string
  title: string
  addedAt: number
}

/** What a client sees of a saved password: never the password itself. */
export interface BrowserCredentialSuggestion {
  id: string
  username: string
  origin: string
}

export interface BrowserCredentialSaveInput {
  origin: string
  username: string
  password: string
  usernameElement?: string
  passwordElement?: string
}

export interface BrowserCredentialSaveResult {
  action: 'created' | 'updated' | 'unchanged'
  credential: BrowserCredentialSuggestion
}

export type BrowserCredentialSaveDisposition = 'create' | 'update' | 'unchanged'

/** A password to import (a client that can read Chrome's store hands the rows over). */
export interface BrowserCredentialImport {
  origin: string
  signonRealm?: string
  username: string
  password: string
  usernameElement?: string
  passwordElement?: string
}

export interface BrowserCredentialImportResult {
  imported: number
  skipped: number
  total: number
}

export interface BrowserCredentialFill {
  username: string
  password: string
  usernameElement: string
}

export type BrowserDownloadState = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted'

export interface BrowserDownloadEntry {
  id: string
  url: string
  filename: string
  /** On the runtime's machine, inside `browser/downloads/` once completed. */
  filePath: string
  state: BrowserDownloadState
  receivedBytes: number
  totalBytes: number
  at: number
}

/** The first event of an upload stream; the file's bytes follow. */
export interface BrowserUploadHeader {
  name: string
  size: number
}

export type BrowserDataChange =
  | { kind: 'history'; entries: BrowserHistoryEntry[] }
  | { kind: 'bookmarks'; bookmarks: BrowserBookmark[] }
