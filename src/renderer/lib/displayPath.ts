// Renderer-safe, locator-aware display helpers.
//
// Workspace roots and file paths are LOCATOR strings (see
// src/main/companion/locator.ts): a bare absolute path is local; a
// `cate-companion://<companionId>/<percent-encoded-posix-path>` URI is remote.
// Naively splitting the raw locator on `/` leaks the scheme and percent-
// encoding into the UI ("cate-companion:", "%20", the companion id segment).
// These helpers decode the locator first so both local and remote paths render
// cleanly. LOCAL output is byte-identical to the old split-based logic.

import { parseLocator } from '../../main/companion/locator'

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
