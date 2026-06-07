// Renderer-safe, locator-aware display helpers.
//
// Workspace roots and file paths are LOCATOR strings (see
// src/main/companion/locator.ts): a bare absolute path is local; a
// `cate-companion://<companionId>/<percent-encoded-posix-path>` URI is remote.
// Naively splitting the raw locator on `/` leaks the scheme and percent-
// encoding into the UI ("cate-companion:", "%20", the companion id segment).
// These helpers decode the locator first so both local and remote paths render
// cleanly. LOCAL output is byte-identical to the old split-based logic.

import { LOCAL_COMPANION_ID, parseLocator } from '../../../main/companion/locator'

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
 * segment, for local OR remote.
 *
 * Local paths are OS-native, so on Windows the separator is `\` — splitting only
 * on `/` would leave the whole `C:\Users\foo\proj` string as the "folder name".
 * Remote paths are always POSIX, where `\` is a legal filename character, so we
 * only treat `\` as a separator for local locators.
 */
export function workspaceDisplayName(locator: string): string {
  const { companionId, path } = parseLocator(locator)
  const sep = companionId === LOCAL_COMPANION_ID ? /[\\/]/ : /\//
  return path.split(sep).filter(Boolean).pop() ?? ''
}
