// =============================================================================
// Resource locator — encodes WHICH runtime an operation targets inside the
// path/cwd string the renderer already passes around.
//
// A workspace is identified by a single string. For the local machine it stays
// a bare absolute path (e.g. "/Users/anton/proj" or "C:\\proj"), so every
// existing persisted path, test, and default code path keeps meaning exactly
// what it does today. For a non-local runtime the string becomes an opaque
// URI:
//
//     cate-runtime://<runtimeId>/<absolute-posix-path>
//
// This is the compact local-path form that lets us route fs/git/terminal operations
// to a remote or WSL runtime WITHOUT threading a new `runtimeId` argument
// through the ~217 preload methods and every renderer call site: the runtime
// rides inside the string, and only a single decode hop at the IPC boundary
// (plus the leaf op) has to care.
// =============================================================================

const SCHEME = 'cate-runtime://'

/** Opaque routing key for a runtime: 'local', 'srv_<id>', 'wsl_<distro>'. */
export type RuntimeId = string

/** The id of the always-present in-process runtime (the local machine). */
export const LOCAL_RUNTIME_ID = 'local'

export interface ResourceLocator {
  /** Routing key. `LOCAL_RUNTIME_ID` for bare paths. */
  runtimeId: string
  /** Runtime-absolute path. Bare (OS-native) for local; POSIX for remote. */
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
 * Decode a path/cwd string into its runtime + path. A string with no
 * `cate-runtime://` scheme is treated as a local path verbatim — this is the
 * implicit-local rule used by every local workspace path.
 */
export function parseLocator(raw: string): ResourceLocator {
  if (typeof raw === 'string' && raw.startsWith(SCHEME)) {
    const rest = raw.slice(SCHEME.length)
    const slash = rest.indexOf('/')
    if (slash === -1) {
      // Authority only, no path component (rare; real locators carry an
      // absolute path). Keep it lossless so it still round-trips.
      return { runtimeId: rest, path: '' }
    }
    return {
      runtimeId: rest.slice(0, slash),
      path: decodePath(rest.slice(slash)),
    }
  }
  return { runtimeId: LOCAL_RUNTIME_ID, path: raw }
}

/**
 * Encode a runtime + path back into a single string. Local runtimes yield
 * the bare path (no scheme), so callers that never touch a remote see exactly
 * the strings they always did.
 */
export function formatLocator(loc: ResourceLocator): string {
  if (loc.runtimeId === LOCAL_RUNTIME_ID) {
    return loc.path
  }
  return SCHEME + loc.runtimeId + encodePath(loc.path)
}

/** True iff `raw` addresses the local machine (bare path / local runtime). */
export function isLocalLocator(raw: string): boolean {
  return parseLocator(raw).runtimeId === LOCAL_RUNTIME_ID
}

/** True when a value is explicitly encoded as a non-local runtime locator. */
export function isRuntimeLocator(raw: unknown): boolean {
  return typeof raw === 'string' && raw.startsWith(SCHEME)
}
