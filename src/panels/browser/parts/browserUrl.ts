// URL helpers for the address bar. Pure: the session normalizes what a view
// or the `cate` API navigates to.

import { SEARCH_ENGINE_URLS, type BrowserSearchEngine } from './searchEngines'

/** Check if input looks like a URL rather than a search query. */
export function isUrl(input: string): boolean {
  const trimmed = input.trim()
  if (trimmed.startsWith('data:')) {
    return true
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return true
  }
  // Local file URL or absolute filesystem path (POSIX `/Users/...` or Windows `C:\...`).
  if (trimmed.startsWith('file://') || trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return true
  }
  // Has spaces: a search query
  if (trimmed.includes(' ')) {
    return false
  }
  // Contains a dot: likely a domain ("example.com", "192.168.1.1")
  if (trimmed.includes('.')) {
    return true
  }
  // "localhost" or "localhost:port"
  if (/^localhost(:\d+)?(\/.*)?$/.test(trimmed)) {
    return true
  }
  // Explicit port on any host (e.g. "myhost:3000")
  if (/^[\w-]+(:\d+)(\/.*)?$/.test(trimmed)) {
    return true
  }
  return false
}

/** Best-effort favicon URL for a page: the site's own `/favicon.ico`. Same-origin
 *  (no third-party lookup service), so it only ever talks to a host the user is
 *  already visiting. Returns undefined for non-web schemes (cate://newtab,
 *  file://, about:) which have no favicon. Used as a fallback when the page
 *  hasn't reported a favicon via page-favicon-updated (e.g. restored/inactive
 *  tabs and bookmarks). The <img> falls back to a globe glyph if this 404s. */
export function faviconForUrl(rawUrl: string): string | undefined {
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    return `${u.origin}/favicon.ico`
  } catch {
    return undefined
  }
}

/** Percent-encode the characters in a filesystem path that would otherwise be
 *  interpreted as URL syntax: `%` (must be escaped first so we don't double-
 *  encode the others), `#` (fragment), and `?` (query). Other characters in
 *  paths (including `/`, `:`, `@`, spaces, unicode (are allowed in a file
 *  URL path without escaping (browsers tolerate them) and we leave them
 *  alone so the URL stays human-readable in the address bar. */
function escapeFilePath(path: string): string {
  return path
    .replace(/%/g, '%25')
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F')
}

/** Normalize a URL string, prepending a protocol if none present.
 *  Uses http:// for localhost/127.0.0.1/[::1], file:// for absolute local
 *  paths, and https:// for everything else. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith('about:')) return trimmed
  if (trimmed.startsWith('data:')) return trimmed
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }
  if (trimmed.startsWith('file://')) return trimmed
  // Absolute POSIX path → file URL
  if (trimmed.startsWith('/')) return `file://${escapeFilePath(trimmed)}`
  // Absolute Windows path (e.g. C:\foo or C:/foo) → file URL with forward slashes
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return `file:///${escapeFilePath(trimmed.replace(/\\/g, '/'))}`
  }
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(trimmed)
  return `${isLocal ? 'http' : 'https'}://${trimmed}`
}

/** What the address bar's input navigates to: a URL, an internal page, or a
 *  search with the workspace's engine. */
export function resolveAddress(input: string, engine: BrowserSearchEngine, isInternal: (url: string) => boolean): string {
  const trimmed = input.trim()
  if (isInternal(trimmed)) return trimmed
  if (isUrl(trimmed)) return normalizeUrl(trimmed)
  return (SEARCH_ENGINE_URLS[engine] ?? SEARCH_ENGINE_URLS.google) + encodeURIComponent(trimmed)
}
