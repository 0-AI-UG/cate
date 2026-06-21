// =============================================================================
// browserStore — renderer mirror of the global browser history + bookmarks owned
// by the main process (see src/main/browserStateStore). One source of truth: all
// mutations go to main and come back as broadcast "changed" events, so every
// browser panel and window stays consistent (the "one Chrome app" behavior).
// =============================================================================
import { create } from 'zustand'
import type { BrowserHistoryEntry, BrowserBookmark } from '../../shared/types'

interface BrowserStore {
  history: BrowserHistoryEntry[]
  bookmarks: BrowserBookmark[]
  /** Load current state from main and subscribe to change broadcasts (once). */
  init: () => Promise<void>
  recordVisit: (url: string, title: string) => void
  toggleBookmark: (url: string, title: string) => void
  isBookmarked: (url: string) => boolean
  removeHistory: (url: string) => void
  clearHistory: () => void
  querySuggestions: (query: string, limit: number) => BrowserHistoryEntry[]
}

// Guard so init()'s IPC subscriptions are wired at most once per renderer.
let subscribed = false

export const useBrowserStore = create<BrowserStore>((set, get) => ({
  history: [],
  bookmarks: [],

  init: async () => {
    const [history, bookmarks] = await Promise.all([
      window.electronAPI.browserHistoryGet(),
      window.electronAPI.browserBookmarksGet(),
    ])
    set({ history: history ?? [], bookmarks: bookmarks ?? [] })
    if (!subscribed) {
      subscribed = true
      window.electronAPI.onBrowserHistoryChanged(() => {
        window.electronAPI.browserHistoryGet().then((h) => set({ history: h ?? [] })).catch(() => {})
      })
      window.electronAPI.onBrowserBookmarksChanged(() => {
        window.electronAPI.browserBookmarksGet().then((b) => set({ bookmarks: b ?? [] })).catch(() => {})
      })
    }
  },

  recordVisit: (url, title) => { void window.electronAPI.browserHistoryRecord(url, title) },

  toggleBookmark: (url, title) => {
    if (get().isBookmarked(url)) void window.electronAPI.browserBookmarksRemove(url)
    else void window.electronAPI.browserBookmarksAdd(url, title)
  },

  isBookmarked: (url) => get().bookmarks.some((b) => b.url === url),

  removeHistory: (url) => { void window.electronAPI.browserHistoryRemove(url) },
  clearHistory: () => { void window.electronAPI.browserHistoryClear() },

  querySuggestions: (query, limit) => {
    const q = query.trim().toLowerCase()
    const base = [...get().history].sort((a, b) => b.lastVisited - a.lastVisited)
    const filtered = q
      ? base.filter((e) => e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q))
      : base
    return filtered.slice(0, limit)
  },
}))
