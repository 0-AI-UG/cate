// History and bookmarks: hand-editable JSON under `<data>/browser/`.

import path from 'node:path'
import { isPlainObject } from '@kernel/state/contract'
import { createJsonStateFile, type JsonStateFile } from '@kernel/state/node'
import {
  isRecordableBrowserUrl,
  queryBrowserHistoryEntries,
  type BrowserBookmark,
  type BrowserDataChange,
  type BrowserHistoryEntry,
} from '../contract'

const MAX_HISTORY = 2000

interface HistoryFile { entries: BrowserHistoryEntry[] }
interface BookmarksFile { bookmarks: BrowserBookmark[] }

function records(parsed: unknown, key: string): Record<string, unknown>[] | null {
  if (!isPlainObject(parsed) || !Array.isArray(parsed[key])) return null
  return (parsed[key] as unknown[]).filter(isPlainObject).filter((e) => typeof e.url === 'string')
}

function openHistoryFile(browserDir: string, debounceMs?: number): JsonStateFile<HistoryFile> {
  return createJsonStateFile<HistoryFile>({
    file: path.join(browserDir, 'history.json'),
    defaults: { entries: [] },
    debounceMs,
    normalize: (parsed, defaults) => {
      const list = records(parsed, 'entries')
      if (!list) return defaults
      return {
        entries: list.map((e) => ({
          url: e.url as string,
          title: typeof e.title === 'string' ? e.title : '',
          lastVisited: typeof e.lastVisited === 'number' ? e.lastVisited : 0,
          visitCount: typeof e.visitCount === 'number' ? e.visitCount : 1,
        })),
      }
    },
  })
}

function openBookmarksFile(browserDir: string, debounceMs?: number): JsonStateFile<BookmarksFile> {
  return createJsonStateFile<BookmarksFile>({
    file: path.join(browserDir, 'bookmarks.json'),
    defaults: { bookmarks: [] },
    debounceMs,
    normalize: (parsed, defaults) => {
      const list = records(parsed, 'bookmarks')
      if (!list) return defaults
      return {
        bookmarks: list.map((b) => ({
          url: b.url as string,
          title: typeof b.title === 'string' ? b.title : '',
          addedAt: typeof b.addedAt === 'number' ? b.addedAt : 0,
        })),
      }
    },
  })
}

export interface HistoryStore {
  history(): BrowserHistoryEntry[]
  queryHistory(query: string, limit: number): BrowserHistoryEntry[]
  recordVisit(url: string, title: string): void
  removeHistoryEntry(url: string): void
  clearHistory(): void
  bookmarks(): BrowserBookmark[]
  addBookmark(url: string, title: string): void
  removeBookmark(url: string): void
  subscribe(cb: (change: BrowserDataChange) => void): () => void
  flush(): Promise<void>
  dispose(): void
}

export function createHistoryStore(
  browserDir: string,
  opts: { now?: () => number; debounceMs?: number } = {},
): HistoryStore {
  const now = opts.now ?? Date.now
  const historyFile = openHistoryFile(browserDir, opts.debounceMs)
  const bookmarksFile = openBookmarksFile(browserDir, opts.debounceMs)
  historyFile.load()
  bookmarksFile.load()

  const history = () => [...historyFile.get().entries].sort((a, b) => b.lastVisited - a.lastVisited)
  const bookmarks = () => bookmarksFile.get().bookmarks

  return {
    history,
    queryHistory: (query, limit) => queryBrowserHistoryEntries(historyFile.get().entries, query, limit),
    recordVisit(url, title) {
      if (!isRecordableBrowserUrl(url)) return
      const at = now()
      historyFile.update((cur) => {
        const existing = cur.entries.find((e) => e.url === url)
        // The visited entry goes to the front: the stable sort by lastVisited
        // keeps this order for visits within the same millisecond.
        const rest = cur.entries.filter((e) => e.url !== url)
        const head: BrowserHistoryEntry = existing
          ? { ...existing, title: title || existing.title, lastVisited: at, visitCount: existing.visitCount + 1 }
          : { url, title, lastVisited: at, visitCount: 1 }
        return { entries: [head, ...rest].slice(0, MAX_HISTORY) }
      })
    },
    removeHistoryEntry(url) {
      historyFile.update((cur) => ({ entries: cur.entries.filter((e) => e.url !== url) }))
    },
    clearHistory() {
      historyFile.set({ entries: [] })
    },
    bookmarks,
    addBookmark(url, title) {
      if (!isRecordableBrowserUrl(url)) return
      bookmarksFile.update((cur) => {
        if (cur.bookmarks.some((b) => b.url === url)) return cur
        return { bookmarks: [{ url, title, addedAt: now() }, ...cur.bookmarks] }
      })
    },
    removeBookmark(url) {
      bookmarksFile.update((cur) => ({ bookmarks: cur.bookmarks.filter((b) => b.url !== url) }))
    },
    subscribe(cb) {
      const offHistory = historyFile.subscribe(() => cb({ kind: 'history', entries: history() }))
      const offBookmarks = bookmarksFile.subscribe(() => cb({ kind: 'bookmarks', bookmarks: bookmarks() }))
      return () => { offHistory(); offBookmarks() }
    },
    async flush() {
      await Promise.all([historyFile.flush(), bookmarksFile.flush()])
    },
    dispose() {
      historyFile.dispose()
      bookmarksFile.dispose()
    },
  }
}
