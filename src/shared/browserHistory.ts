import type { BrowserHistoryEntry } from './types'

/** Stable browser-history ordering and filtering shared by main and renderer. */
export function queryBrowserHistoryEntries(
  entries: BrowserHistoryEntry[],
  query: string,
  limit: number,
): BrowserHistoryEntry[] {
  const normalized = query.trim().toLowerCase()
  const sorted = [...entries].sort((a, b) => b.lastVisited - a.lastVisited)
  const filtered = normalized
    ? sorted.filter((entry) =>
        entry.url.toLowerCase().includes(normalized) || entry.title.toLowerCase().includes(normalized))
    : sorted
  return filtered.slice(0, limit)
}
