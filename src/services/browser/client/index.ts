// services/browser client side: the page bridge and partition slots the shell
// fills, and a store of the workspace's history and bookmarks.

import type { CapabilityProxy } from '@kernel/rpc/contract'
import {
  queryBrowserHistoryEntries,
  workspacePartition,
  type BrowserBookmark,
  type BrowserHistoryEntry,
  type BrowserPageBridge,
  type browserDataCapability,
} from '../contract'

let bridge: BrowserPageBridge | null = null

/** The desktop shell installs its page bridge (preload); other shells none. */
export function installBrowserPageBridge(next: BrowserPageBridge | null): void {
  bridge = next
}

export function browserPageBridge(): BrowserPageBridge | null {
  return bridge
}

/** The shell's partitions: null for a workspace whose partition is not
 *  prepared yet, and a signal when that changes. */
export interface BrowserPartitionSource {
  partition(workspaceId: string): string | null
  subscribe(listener: () => void): () => void
}

let source: BrowserPartitionSource | null = null
const listeners = new Set<() => void>()
let stopSource: (() => void) | null = null

/** The shell names each workspace's partition (`persist:ws-<runtimeId>`), since
 *  it knows the runtime id behind a workspace and routes that partition
 *  through the workspace's loopback proxy. */
export function installBrowserPartitions(next: BrowserPartitionSource | null): void {
  stopSource?.()
  source = next
  const notify = () => { for (const listener of [...listeners]) listener() }
  stopSource = next ? next.subscribe(notify) : null
  notify()
}

/** The workspace's partition, or null while the shell prepares it. Without a
 *  shell source every workspace has its own named partition. */
export function browserPartition(workspaceId: string): string | null {
  if (source) return source.partition(workspaceId)
  return workspacePartition(workspaceId.replace(/[^A-Za-z0-9_-]/g, '_'))
}

export function subscribeBrowserPartitions(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

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
