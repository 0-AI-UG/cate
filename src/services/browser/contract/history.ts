import { BROWSER_NEW_TAB_URL, type BrowserHistoryEntry } from './types'

/** Stable history ordering and filtering, run by the runtime and by clients. */
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

/** Real, navigable pages only: never the start-page sentinel or about: URLs. */
export function isRecordableBrowserUrl(url: string): boolean {
  return !!url && url !== BROWSER_NEW_TAB_URL && !url.startsWith('about:')
}

/** `http(s)` origin of a URL, or null. Passwords are keyed by it. */
export function credentialOrigin(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}
