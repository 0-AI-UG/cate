// =============================================================================
// browserStateStore — global, hand-editable browser history + bookmarks under
// <userData>/, via ./jsonStateFile. Shared across ALL workspaces and windows so
// Cate's browser panels behave like one consistent browser. Cookies/logins are
// already shared via the `persist:browser-shared` partition (see BrowserPanel);
// this adds the history + bookmarks Chromium does not expose through <webview>.
// =============================================================================
import { createJsonStateFile } from './jsonStateFile'
import { isPlainObject } from './jsonUtils'
import type { BrowserHistoryEntry, BrowserBookmark } from '../shared/types'
import { BROWSER_NEW_TAB_URL } from '../shared/types'

const MAX_HISTORY = 2000

interface HistoryFile { entries: BrowserHistoryEntry[] }
interface BookmarksFile { bookmarks: BrowserBookmark[] }

function asObject(parsed: unknown): Record<string, unknown> {
  return isPlainObject(parsed) ? parsed : {}
}

/** Real, navigable pages only — never the start-page sentinel or about: URLs. */
function isRecordable(url: string): boolean {
  return !!url && url !== BROWSER_NEW_TAB_URL && !url.startsWith('about:')
}

const historyStore = createJsonStateFile<HistoryFile>({
  filename: 'browser-history.json',
  defaults: { entries: [] },
  normalize: (parsed, defaults) => {
    const o = asObject(parsed)
    if (!Array.isArray(o.entries)) return defaults
    const entries = o.entries
      .filter((e) => e && typeof e === 'object')
      .map((e) => e as Record<string, unknown>)
      .filter((e) => typeof e.url === 'string')
      .map((e) => ({
        url: e.url as string,
        title: typeof e.title === 'string' ? e.title : '',
        lastVisited: typeof e.lastVisited === 'number' ? e.lastVisited : 0,
        visitCount: typeof e.visitCount === 'number' ? e.visitCount : 1,
      }))
    return { entries }
  },
})

const bookmarksStore = createJsonStateFile<BookmarksFile>({
  filename: 'browser-bookmarks.json',
  defaults: { bookmarks: [] },
  normalize: (parsed, defaults) => {
    const o = asObject(parsed)
    if (!Array.isArray(o.bookmarks)) return defaults
    const bookmarks = o.bookmarks
      .filter((b) => b && typeof b === 'object')
      .map((b) => b as Record<string, unknown>)
      .filter((b) => typeof b.url === 'string')
      .map((b) => ({
        url: b.url as string,
        title: typeof b.title === 'string' ? b.title : '',
        addedAt: typeof b.addedAt === 'number' ? b.addedAt : 0,
      }))
    return { bookmarks }
  },
})

export function recordBrowserVisit(url: string, title: string): void {
  if (!isRecordable(url)) return
  const now = Date.now()
  historyStore.update((cur) => {
    const existing = cur.entries.find((e) => e.url === url)
    // Always put the just-visited entry at the front. getBrowserHistory's stable
    // sort by lastVisited then preserves this order for ties — important because
    // several visits can share one Date.now() millisecond.
    const rest = cur.entries.filter((e) => e.url !== url)
    const head: BrowserHistoryEntry = existing
      ? { ...existing, title: title || existing.title, lastVisited: now, visitCount: existing.visitCount + 1 }
      : { url, title, lastVisited: now, visitCount: 1 }
    return { entries: [head, ...rest].slice(0, MAX_HISTORY) }
  })
}

export function getBrowserHistory(): BrowserHistoryEntry[] {
  return [...historyStore.get().entries].sort((a, b) => b.lastVisited - a.lastVisited)
}

export function queryBrowserHistory(query: string, limit: number): BrowserHistoryEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return getBrowserHistory().slice(0, limit)
  return getBrowserHistory()
    .filter((e) => e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q))
    .slice(0, limit)
}

export function removeBrowserHistoryEntry(url: string): void {
  historyStore.update((cur) => ({ entries: cur.entries.filter((e) => e.url !== url) }))
}

export function clearBrowserHistory(): void {
  historyStore.set({ entries: [] })
}

export function getBookmarks(): BrowserBookmark[] {
  return bookmarksStore.get().bookmarks
}

export function addBookmark(url: string, title: string): void {
  if (!isRecordable(url)) return
  bookmarksStore.update((cur) => {
    if (cur.bookmarks.some((b) => b.url === url)) return cur
    return { bookmarks: [{ url, title, addedAt: Date.now() }, ...cur.bookmarks] }
  })
}

export function removeBookmark(url: string): void {
  bookmarksStore.update((cur) => ({ bookmarks: cur.bookmarks.filter((b) => b.url !== url) }))
}

/** Start watching both files for EXTERNAL hand-edits. `onChange` fires so the
 *  caller can re-broadcast the new state to all renderer windows. */
export function startWatchingBrowserState(onChange: () => void): void {
  historyStore.startWatching(() => onChange())
  bookmarksStore.startWatching(() => onChange())
}

/** Flush any pending debounced writes synchronously (call on app quit). */
export function flushBrowserStateSync(): void {
  historyStore.flushPendingWritesSync()
  bookmarksStore.flushPendingWritesSync()
}
