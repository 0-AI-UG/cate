// Renderer-safe, locator-aware display helpers.
//
// Workspace roots and file paths are LOCATOR strings (see
// src/main/companion/locator.ts): a bare absolute path is local; a
// `cate-companion://<companionId>/<percent-encoded-posix-path>` URI is remote.
// Naively splitting the raw locator on `/` leaks the scheme and percent-
// encoding into the UI ("cate-companion:", "%20", the companion id segment).
// These helpers decode the locator first so both local and remote paths render
// cleanly. LOCAL output is byte-identical to the old split-based logic.

import { parseLocator, LOCAL_COMPANION_ID } from '../../main/companion/locator'
import type { CompanionConnection } from '../../shared/types'

/** Abbreviate a macOS home-dir path to `~/...`, matching WelcomePage's legacy
 *  behavior exactly. */
export function abbreviateLocalPath(fullPath: string): string {
  const home = '/Users/'
  if (fullPath.startsWith(home)) {
    const rest = fullPath.slice(home.length)
    const slashIdx = rest.indexOf('/')
    return '~' + (slashIdx >= 0 ? rest.slice(slashIdx) : '')
  }
  return fullPath
}

/**
 * Basename for display. Decodes the locator and returns the last non-empty path
 * segment, for local OR remote. For a local path this is identical to
 * `raw.split('/').filter(Boolean).pop()`.
 */
export function workspaceDisplayName(locator: string): string {
  const { path } = parseLocator(locator)
  return path.split('/').filter(Boolean).pop() ?? ''
}

/**
 * Human-readable label for a locator's location.
 * - Local: the abbreviated (`~/...`) path, identical to today.
 * - Remote: best-effort `user@host:/path` (server) or `wsl:<distro>/path`
 *   when a connection is supplied; otherwise a decoded `companionId:/posix/path`
 *   derived from the locator. Never shows raw `cate-companion://` or `%20`.
 */
export function displayPathLabel(
  locator: string,
  connection?: CompanionConnection,
): string {
  const { companionId, path } = parseLocator(locator)
  if (companionId === LOCAL_COMPANION_ID) {
    return abbreviateLocalPath(path)
  }
  if (connection && connection.kind === 'server') {
    const hostPart = connection.port
      ? `${connection.host}:${connection.port}`
      : connection.host
    return `${connection.user}@${hostPart}:${path}`
  }
  if (connection && connection.kind === 'wsl') {
    return `wsl:${connection.distro}${path}`
  }
  // No (or only local) connection info — derive a clean label from the decoded
  // locator. The companion id is the best available host hint.
  return `${companionId}:${path}`
}
