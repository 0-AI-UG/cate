// =============================================================================
// Resource locator — encodes WHICH companion an operation targets inside the
// path/cwd string the renderer already passes around.
//
// A workspace is identified by a single string. For the local machine it stays
// a bare absolute path (e.g. "/Users/anton/proj" or "C:\\proj"), so every
// existing persisted path, test, and default code path keeps meaning exactly
// what it does today. For a non-local companion the string becomes an opaque
// URI:
//
//     cate-companion://<companionId>/<absolute-posix-path>
//
// This is the back-compat anchor that lets us route fs/git/terminal operations
// to a remote or WSL companion WITHOUT threading a new `companionId` argument
// through the ~217 preload methods and every renderer call site: the companion
// rides inside the string, and only a single decode hop at the IPC boundary
// (plus the leaf op) has to care.
// =============================================================================

const SCHEME = 'cate-companion://'

/** Opaque routing key for a companion: 'local', 'srv_<id>', 'wsl_<distro>'. */
export type CompanionId = string

/** The id of the always-present in-process companion (the local machine). */
export const LOCAL_COMPANION_ID = 'local'

export interface ResourceLocator {
  /** Routing key. `LOCAL_COMPANION_ID` for bare paths. */
  companionId: string
  /** Companion-absolute path. Bare (OS-native) for local; POSIX for remote. */
  path: string
}

// Path components are percent-encoded per segment so spaces / reserved chars
// survive the URI form. `/` separators are preserved (we encode each segment,
// not the whole string).
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}

function decodePath(p: string): string {
  return p.split('/').map(decodeURIComponent).join('/')
}

/**
 * Decode a path/cwd string into its companion + path. A string with no
 * `cate-companion://` scheme is treated as a local path verbatim — this is the
 * implicit-local rule every legacy path relies on.
 */
export function parseLocator(raw: string): ResourceLocator {
  if (typeof raw === 'string' && raw.startsWith(SCHEME)) {
    const rest = raw.slice(SCHEME.length)
    const slash = rest.indexOf('/')
    if (slash === -1) {
      // Authority only, no path component (rare; real locators carry an
      // absolute path). Keep it lossless so it still round-trips.
      return { companionId: rest, path: '' }
    }
    return {
      companionId: rest.slice(0, slash),
      path: decodePath(rest.slice(slash)),
    }
  }
  return { companionId: LOCAL_COMPANION_ID, path: raw }
}

/**
 * Encode a companion + path back into a single string. Local companions yield
 * the bare path (no scheme), so callers that never touch a remote see exactly
 * the strings they always did.
 */
export function formatLocator(loc: ResourceLocator): string {
  if (loc.companionId === LOCAL_COMPANION_ID) {
    return loc.path
  }
  return SCHEME + loc.companionId + encodePath(loc.path)
}

/** True iff `raw` addresses the local machine (bare path / local companion). */
export function isLocalLocator(raw: string): boolean {
  return parseLocator(raw).companionId === LOCAL_COMPANION_ID
}
