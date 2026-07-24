// =============================================================================
// URL helpers for the BrowserPanel address bar.
//
// Lives outside the React component so unit tests can import them without
// dragging the rest of the component (and Electron/React) into the test
// environment.
// =============================================================================

import { isRuntimeLocator } from '../../shared/runtimeLocator'

/** Check if input looks like a URL rather than a search query. */
export function isUrl(input: string): boolean {
  const trimmed = input.trim()
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return true
  }
  // Local file URL or absolute filesystem path (POSIX `/Users/...` or Windows `C:\...`).
  if (trimmed.startsWith('file://') || trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return true
  }
  // A remote-workspace locator is URL-shaped, not a search query — treating it
  // as a search would leak the path to the search engine.
  if (isRuntimeLocator(trimmed)) return true
  // Has spaces — definitely a search query
  if (trimmed.includes(' ')) {
    return false
  }
  // Contains a dot — likely a domain (e.g. "example.com", "192.168.1.1")
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
 *  paths — including `/`, `:`, `@`, spaces, unicode — are allowed in a file
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
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }
  if (trimmed.startsWith('file://')) return trimmed
  // Remote-workspace locator: the embedded browser is a LOCAL Chromium and can
  // never read a remote host's file. Pass it through untouched so the load
  // fails visibly (unknown scheme) instead of being rewritten into a local
  // file:// path or an https:// guess that points somewhere else entirely.
  if (isRuntimeLocator(trimmed)) return trimmed
  // Absolute POSIX path → file URL
  if (trimmed.startsWith('/')) return `file://${escapeFilePath(trimmed)}`
  // Absolute Windows path (e.g. C:\foo or C:/foo) → file URL with forward slashes
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return `file:///${escapeFilePath(trimmed.replace(/\\/g, '/'))}`
  }
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(trimmed)
  return `${isLocal ? 'http' : 'https'}://${trimmed}`
}
