// services/browser client side: a store of the workspace's history and
// bookmarks (webview partitions and the page bridge are the desktop side's).

import type { CapabilityProxy } from '@kernel/rpc/contract'
import {
  queryBrowserHistoryEntries,
  type BrowserBookmark,
  type BrowserHistoryEntry,
  type browserDataCapability,
} from '../contract'

export interface BrowserDataState {
  history: BrowserHistoryEntry[]
  bookmarks: BrowserBookmark[]
}

export interface BrowserDataStore {
  getState(): BrowserDataState
  subscribe(listener: () => void): () => void
  isBookmarked(url: string): boolean
  toggleBookmark(url: string, title: string): Promise<void>
  removeHistory(url: string): Promise<void>
  clearHistory(): Promise<void>
  suggestions(query: string, limit: number): BrowserHistoryEntry[]
  dispose(): void
}

/** History and bookmarks of one workspace, kept current by `browserData.changes`. */
export function createBrowserDataStore(browserData: CapabilityProxy<typeof browserDataCapability>): BrowserDataStore {
  let state: BrowserDataState = { history: [], bookmarks: [] }
  const listeners = new Set<() => void>()
  const set = (patch: Partial<BrowserDataState>) => {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }
  let disposed = false
  void Promise.all([browserData.history(), browserData.bookmarks()])
    .then(([history, bookmarks]) => { if (!disposed) set({ history, bookmarks }) })
    .catch(() => { /* offline; the change stream fills in on reconnect */ })
  const changes = browserData.changes(undefined, { resume: true })
  changes.onEvent((change) => {
    if (change.kind === 'history') set({ history: change.entries })
    else set({ bookmarks: change.bookmarks })
  })
  const isBookmarked = (url: string) => state.bookmarks.some((bookmark) => bookmark.url === url)
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    isBookmarked,
    toggleBookmark: (url, title) => (isBookmarked(url) ? browserData.removeBookmark({ url }) : browserData.addBookmark({ url, title })),
    removeHistory: (url) => browserData.removeHistoryEntry({ url }),
    clearHistory: () => browserData.clearHistory(),
    suggestions: (query, limit) => queryBrowserHistoryEntries(state.history, query, limit),
    dispose() {
      disposed = true
      changes.cancel()
      listeners.clear()
    },
  }
}
