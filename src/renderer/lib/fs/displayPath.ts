// Renderer-safe, locator-aware display helpers.
//
// Workspace roots and file paths are LOCATOR strings (see
// src/main/runtime/locator.ts): a bare absolute path is local; a
// `cate-runtime://<runtimeId>/<percent-encoded-posix-path>` URI is remote.
// Naively splitting the raw locator on `/` leaks the scheme and percent-
// encoding into the UI ("cate-runtime:", "%20", the runtime id segment).
// These helpers decode the locator first so both local and remote paths render
// cleanly. LOCAL output is byte-identical to the old split-based logic.

import { LOCAL_RUNTIME_ID, parseLocator } from '../../../main/runtime/locator'

/** Abbreviate a macOS home-dir path to `~/...`, matching WelcomePage's
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
export function pathDisplayName(locator: string): string {
  const { runtimeId, path } = parseLocator(locator)
  const sep = runtimeId === LOCAL_RUNTIME_ID ? /[\\/]/ : /\//
  return path.split(sep).filter(Boolean).pop() ?? ''
}

export const workspaceDisplayName = pathDisplayName

/**
 * Workspace-relative path for display / clipboard. Decodes both locators and
 * returns the host-relative path when `locator` sits inside `rootLocator` on
 * the same runtime; otherwise the decoded absolute host path. Local Windows
 * paths are compared with normalized separators (mirrors shared/pathUtils).
 */
export function relativeDisplayPath(locator: string, rootLocator: string): string {
  const file = parseLocator(locator)
  const root = parseLocator(rootLocator)
  if (file.runtimeId !== root.runtimeId) return file.path
  const norm = (p: string): string =>
    (file.runtimeId === LOCAL_RUNTIME_ID ? p.replace(/\\/g, '/') : p).replace(/\/+$/, '')
  const normFile = norm(file.path)
  const normRoot = norm(root.path)
  if (normRoot && normFile.startsWith(normRoot + '/')) return normFile.slice(normRoot.length + 1)
  return file.path
}
