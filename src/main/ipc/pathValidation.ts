// =============================================================================
// Path validation — prevent path traversal and restrict filesystem access
// to registered workspace roots and the system temp directory.
// =============================================================================

import fs from 'fs/promises'
import path from 'path'
import os from 'os'

// Per-workspace ("scope") allowed-root registry. Each scopeId is a workspace id.
// Phase 1 records which roots belong to which workspace and threads the scopeId
// end-to-end (renderer -> IPC -> companion -> daemon), but does NOT yet use it to
// restrict access — isWithinAllowedRoots still checks the union of all scopes'
// roots (pre-isolation behavior). Strict per-workspace enforcement is deferred to
// Phase 3. Calls without a scopeId land under the LEGACY key (home/agent dirs,
// daemon root, dev trust-scoping override) and stay globally allowed by design.
const LEGACY_SCOPE = '__legacy_global__'
const rootsByScope = new Map<string, Set<string>>()

const scopedWriteAllowances = new Map<number, Map<string, ReturnType<typeof setTimeout>>>()
const DEFAULT_WRITE_ALLOWANCE_TTL_MS = 60_000

// Windows paths are case-insensitive: a root or grant registered with different
// casing than the request must still match. POSIX stays case-sensitive. The
// comparison key is exported for unit-testing the win32 branch with an injected
// platform (the live calls use the real process.platform).
export function pathCompareKey(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? p.toLowerCase() : p
}

// Persistent per-window grants for files the user explicitly chose outside
// the workspace roots (e.g. via the native Save-As dialog). Unlike scoped
// write allowances, these:
//   - cover both read AND write
//   - have no TTL (live until the window closes)
//   - are not consumed on use
// They are stored by the resolved real-path-of-parent + basename so that a
// symlink shenanigan inside an allowed root can't laundry a sensitive
// location into the grant set.
const persistentFileGrants = new Map<number, Set<string>>()

export function addAllowedRoot(root: string, scopeId?: string): void {
  const key = scopeId ?? LEGACY_SCOPE
  const set = rootsByScope.get(key) ?? new Set<string>()
  set.add(path.resolve(root))
  rootsByScope.set(key, set)
}

export function removeAllowedRoot(root: string, scopeId?: string): void {
  const key = scopeId ?? LEGACY_SCOPE
  const set = rootsByScope.get(key)
  if (!set) return
  set.delete(path.resolve(root))
  if (set.size === 0) rootsByScope.delete(key)
}

export function getAllowedRoots(): ReadonlySet<string> {
  // Union of every scope's roots — some callers/tests want the global view.
  const union = new Set<string>()
  for (const set of rootsByScope.values()) {
    for (const root of set) union.add(root)
  }
  return union
}

// True if `key` (a pre-computed pathCompareKey) is the root itself or sits under
// it. Roots are already path.resolve'd at registration; key-compare them so the
// win32 case-insensitive match holds.
function keyUnderRoots(key: string, roots: Iterable<string>): boolean {
  for (const root of roots) {
    const rootKey = pathCompareKey(root)
    if (key.startsWith(rootKey + path.sep) || key === rootKey) {
      return true
    }
  }
  return false
}

function isWithinAllowedRoots(normalized: string, scopeId?: string): boolean {
  const key = pathCompareKey(normalized)
  const tmpKey = pathCompareKey(path.resolve(os.tmpdir()))
  if (key === tmpKey || key.startsWith(tmpKey + path.sep)) {
    return true
  }

  // Phase 1 lands the SCOPE-THREADING INFRASTRUCTURE only: `scopeId` is recorded
  // per workspace (see addAllowedRoot / rootsByScope) and is now carried end-to-end
  // from the renderer through to this validator, but it is intentionally NOT used to
  // restrict access yet. The check stays the pre-isolation "union of every open
  // workspace's roots" so behavior is unchanged. Strict per-workspace enforcement
  // (allow only `scopeId`'s own roots, denying cross-workspace access) is deferred to
  // Phase 3, where each local workspace gets its own daemon rooted at its own root —
  // see keyUnderRoots(key, rootsByScope.get(scopeId)) for the future strict branch.
  void scopeId
  for (const set of rootsByScope.values()) {
    if (keyUnderRoots(key, set)) return true
  }
  return false
}

async function normalizeCreationTarget(filePath: string): Promise<string> {
  const parentDir = path.dirname(path.resolve(filePath))
  const baseName = path.basename(filePath)

  if (!baseName || baseName === '.' || baseName === '..' || baseName.includes('\0')) {
    throw new Error(`Access denied: invalid entry name "${baseName}"`)
  }

  let realParent: string
  try {
    realParent = await fs.realpath(parentDir)
  } catch (err) {
    throw new Error(`Access denied: cannot resolve real path for parent "${parentDir}": ${err}`)
  }

  return path.join(realParent, baseName)
}

function clearScopedWriteAllowance(windowId: number, safePath: string): void {
  const allowances = scopedWriteAllowances.get(windowId)
  const key = pathCompareKey(safePath)
  const timer = allowances?.get(key)
  if (timer) clearTimeout(timer)
  allowances?.delete(key)
  if (allowances && allowances.size === 0) {
    scopedWriteAllowances.delete(windowId)
  }
}

function hasScopedWriteAllowance(windowId: number | undefined, safePath: string): boolean {
  if (windowId == null) return false
  return scopedWriteAllowances.get(windowId)?.has(pathCompareKey(safePath)) ?? false
}

export async function registerScopedWriteAllowance(
  windowId: number,
  filePath: string,
  ttlMs = DEFAULT_WRITE_ALLOWANCE_TTL_MS,
): Promise<string> {
  const safePath = await normalizeCreationTarget(filePath)
  clearScopedWriteAllowance(windowId, safePath)
  const timer = setTimeout(() => {
    clearScopedWriteAllowance(windowId, safePath)
  }, ttlMs)
  const allowances = scopedWriteAllowances.get(windowId) ?? new Map<string, ReturnType<typeof setTimeout>>()
  allowances.set(pathCompareKey(safePath), timer)
  scopedWriteAllowances.set(windowId, allowances)
  return safePath
}

export function consumeScopedWriteAllowance(windowId: number, safePath: string): void {
  clearScopedWriteAllowance(windowId, safePath)
}

export function clearScopedWriteAllowancesForWindow(windowId: number): void {
  const allowances = scopedWriteAllowances.get(windowId)
  if (!allowances) return
  for (const timer of allowances.values()) clearTimeout(timer)
  scopedWriteAllowances.delete(windowId)
}

/**
 * Persistently grant a window read+write access to a single file path. Used
 * by the Save-As / Open-File dialogs so the file the user explicitly picked
 * stays accessible for the rest of the window's lifetime even when it sits
 * outside any workspace root. Returns the resolved safe path (realpath of
 * parent + basename).
 */
export async function grantFileAccess(windowId: number, filePath: string): Promise<string> {
  const safePath = await normalizeCreationTarget(filePath)
  const set = persistentFileGrants.get(windowId) ?? new Set<string>()
  set.add(pathCompareKey(safePath))
  persistentFileGrants.set(windowId, set)
  return safePath
}

function hasGrantedFile(windowId: number | undefined, normalized: string): boolean {
  if (windowId == null) return false
  return persistentFileGrants.get(windowId)?.has(pathCompareKey(normalized)) ?? false
}

export function clearFileGrantsForWindow(windowId: number): void {
  persistentFileGrants.delete(windowId)
}

/**
 * Validates that a file path is within an allowed root directory or
 * persistently granted to the calling window. Returns the normalized
 * absolute path if valid, throws if not.
 */
export function validatePath(filePath: string, ownerWindowId?: number, scopeId?: string): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Access denied: invalid path')
  }

  const normalized = path.resolve(filePath)
  if (isWithinAllowedRoots(normalized, scopeId)) {
    return normalized
  }
  if (hasGrantedFile(ownerWindowId, normalized)) {
    return normalized
  }

  throw new Error(`Access denied: path "${filePath}" is outside allowed directories`)
}

/**
 * Validates that a file path is within an allowed root directory AND that its
 * fully-resolved (symlink-free) real path is also within an allowed root.
 * This prevents TOCTOU attacks where a symlink inside a workspace root points
 * to a sensitive path outside it (e.g. /etc/passwd). A persistent per-window
 * grant on either the lexical or the realpath form also satisfies the check.
 *
 * Returns the real absolute path if valid, throws if not.
 */
export async function validatePathStrict(filePath: string, ownerWindowId?: number, scopeId?: string): Promise<string> {
  // First do the cheap lexical check so we fail fast on obviously bad input.
  validatePath(filePath, ownerWindowId, scopeId)

  let real: string
  try {
    real = await fs.realpath(filePath)
  } catch (err) {
    throw new Error(`Access denied: cannot resolve real path for "${filePath}": ${err}`)
  }

  if (isWithinAllowedRoots(real, scopeId)) {
    return real
  }
  if (hasGrantedFile(ownerWindowId, real)) {
    return real
  }

  throw new Error(`Access denied: resolved path "${real}" is outside allowed directories`)
}

/**
 * Validates a path for file/directory creation.  The target itself need not
 * exist yet, but its parent directory must exist and resolve (symlink-free)
 * to a location within an allowed root.  The basename is checked for
 * obviously dangerous values (.., null bytes, etc.).
 *
 * Returns the safe absolute path (`realParent + baseName`).
 */
export async function validatePathForCreation(filePath: string, ownerWindowId?: number, scopeId?: string): Promise<string> {
  const normalized = path.resolve(filePath)
  const safeTarget = await normalizeCreationTarget(filePath)
  if (isWithinAllowedRoots(normalized, scopeId) || isWithinAllowedRoots(safeTarget, scopeId)) {
    return safeTarget
  }
  if (hasGrantedFile(ownerWindowId, safeTarget)) {
    return safeTarget
  }
  if (hasScopedWriteAllowance(ownerWindowId, safeTarget)) {
    return safeTarget
  }
  throw new Error(`Access denied: resolved parent "${path.dirname(safeTarget)}" is outside allowed directories`)
}

/**
 * Validates a directory path for git/shell operations.
 * Same as validatePath but specifically for cwd parameters.
 */
export function validateCwd(cwd: string, ownerWindowId?: number, scopeId?: string): string {
  return validatePath(cwd, ownerWindowId, scopeId)
}
