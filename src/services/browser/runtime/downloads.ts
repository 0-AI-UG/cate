// The downloads list per browser panel. The page downloads on a client, which
// uploads each finished file into `browser/downloads/` through `file` (so
// agents find it) and records the entry here for every client to show.

import type { BrowserDownloadEntry } from '../contract'

const COMPLETED_PER_PANEL = 20

const isActive = (entry: BrowserDownloadEntry) => entry.state === 'progressing' || entry.state === 'paused'

export interface DownloadsList {
  list(panelId: string): BrowserDownloadEntry[]
  record(panelId: string, entry: BrowserDownloadEntry): void
  remove(panelId: string, id: string): void
  subscribe(panelId: string, cb: (entries: BrowserDownloadEntry[]) => void): () => void
}

export function createDownloadsList(): DownloadsList {
  const byPanel = new Map<string, BrowserDownloadEntry[]>()
  const listeners = new Map<string, Set<(entries: BrowserDownloadEntry[]) => void>>()

  const list = (panelId: string) => (byPanel.get(panelId) ?? []).map((entry) => ({ ...entry }))
  const changed = (panelId: string) => {
    const snapshot = list(panelId)
    for (const cb of listeners.get(panelId) ?? []) cb(snapshot)
  }
  const store = (panelId: string, entries: BrowserDownloadEntry[]) => {
    if (entries.length) byPanel.set(panelId, entries)
    else byPanel.delete(panelId)
    changed(panelId)
  }

  return {
    list,
    record(panelId, entry) {
      const rest = (byPanel.get(panelId) ?? []).filter((e) => e.id !== entry.id)
      const next = [...rest, { ...entry }]
      const completed = next.filter((e) => !isActive(e)).sort((a, b) => a.at - b.at)
      const dropped = new Set(completed.slice(0, -COMPLETED_PER_PANEL).map((e) => e.id))
      store(panelId, next.filter((e) => !dropped.has(e.id)))
    },
    remove(panelId, id) {
      store(panelId, (byPanel.get(panelId) ?? []).filter((e) => e.id !== id))
    },
    subscribe(panelId, cb) {
      const set = listeners.get(panelId) ?? new Set()
      set.add(cb)
      listeners.set(panelId, set)
      return () => {
        set.delete(cb)
        if (!set.size) listeners.delete(panelId)
      }
    },
  }
}
