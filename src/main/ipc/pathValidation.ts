// =============================================================================
// Path validation — prevent path traversal and restrict filesystem access
// to registered workspace roots and the system temp directory.
// =============================================================================

import fs from 'fs/promises'
import { realpathSync } from 'fs'
import path from 'path'
import os from 'os'

// scope -> (resolved root as registered -> every canonical form used for matching)
const rootsByScope = new Map<string, Map<string, string[]>>()

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

// A root must match both the lexical form callers pass around AND the
// symlink-free form the strict (realpath-based) checks produce. The two can
// differ even without user symlinks: macOS /tmp is a symlink to /private/tmp,
// and Windows 8.3 short names (C:\Users\RUNNER~1) expand to long names via the
// native realpath that validatePathStrict uses. Registering only the lexical
// form would make the strict check reject paths that are genuinely inside the
// root, so each root is stored with every canonical form we can compute.
function canonicalForms(resolved: string): string[] {
  try {
    const real = realpathSync.native(resolved)
    if (pathCompareKey(real) !== pathCompareKey(resolved)) return [resolved, real]
  } catch {
    // Root doesn't exist (yet) — lexical form only.
  }
  return [resolved]
}

export function addAllowedRoot(root: string, scopeId: string): void {
  if (!scopeId) throw new Error('A path scope is required')
  const map = rootsByScope.get(scopeId) ?? new Map<string, string[]>()
  const resolved = path.resolve(root)
  map.set(resolved, canonicalForms(resolved))
  rootsByScope.set(scopeId, map)
}

export function removeAllowedRoot(root: string, scopeId: string): void {
  if (!scopeId) throw new Error('A path scope is required')
  const map = rootsByScope.get(scopeId)
  if (!map) return
  map.delete(path.resolve(root))
  if (map.size === 0) rootsByScope.delete(scopeId)
}

/** Register a related root (for example a git worktree) under every scope that
 *  owns `sourcePath`. The fallback is the daemon's own runtime scope, used when
 *  the workspace-specific root has not reached the daemon yet. */
export function addAllowedRootForRelatedPath(root: string, sourcePath: string, fallbackScopeId: string): void {
  const sourceKey = pathCompareKey(path.resolve(sourcePath))
  const matchingScopes: string[] = []
  for (const [scopeId, roots] of rootsByScope) {
    if ([...roots.values()].some((forms) => keyUnderRoots(sourceKey, forms))) {
      matchingScopes.push(scopeId)
    }
  }
  for (const scopeId of matchingScopes.length ? matchingScopes : [fallbackScopeId]) {
    addAllowedRoot(root, scopeId)
  }
}

/** Remove an exact related root from every scope it was propagated to. */
export function removeAllowedRootFromAllScopes(root: string): void {
  const resolved = path.resolve(root)
  for (const [scopeId, roots] of rootsByScope) {
    roots.delete(resolved)
    if (roots.size === 0) rootsByScope.delete(scopeId)
  }
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

// os.tmpdir() in both lexical and realpath form (see canonicalForms), computed
// once — it's checked on every validation and never changes within a process.
let tmpDirForms: string[] | undefined

function isWithinAllowedRoots(normalized: string, scopeId?: string): boolean {
  if (!scopeId) return false
  const key = pathCompareKey(normalized)
  tmpDirForms ??= canonicalForms(path.resolve(os.tmpdir()))
  if (keyUnderRoots(key, tmpDirForms)) {
    return true
  }

  const roots = rootsByScope.get(scopeId)
  if (!roots) return false
  for (const forms of roots.values()) {
    if (keyUnderRoots(key, forms)) return true
  }
  return false
}

/**
 * Resolve a path to its real (symlink-free) form, tolerating a target that
 * does not exist yet. `fs.realpath` throws ENOENT for a missing path, but
 * several callers legitimately validate before creation: a fresh
 * `pi-agent/sessions/<cwd>` dir that `readDir` should report as empty, or a
 * `mkdir` destination whose parent chain doesn't exist yet. For those we
 * realpath the nearest EXISTING ancestor and re-append the missing tail.
 *
 * This keeps the symlink-escape protection intact: every segment that actually
 * exists is resolved (a symlink can only exist if its segment exists), so a
 * symlink pointing outside an allowed root still resolves and gets rejected.
 * Only not-yet-created segments — which cannot be symlinks — stay literal.
 * Non-ENOENT errors (e.g. EACCES) are rethrown so genuine access failures keep
 * surfacing as access errors rather than being mistaken for "doesn't exist".
 */
async function realpathAllowingMissing(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath)
  const missing: string[] = []
  let cur = resolved
  for (;;) {
    try {
      const real = await fs.realpath(cur)
      return missing.length ? path.join(real, ...missing) : real
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const parent = path.dirname(cur)
    if (parent === cur) return resolved // reached the fs root with nothing existing
    missing.unshift(path.basename(cur))
    cur = parent
  }
}

async function normalizeCreationTarget(filePath: string): Promise<string> {
  const parentDir = path.dirname(path.resolve(filePath))
  const baseName = path.basename(filePath)

  if (!baseName || baseName === '.' || baseName === '..' || baseName.includes('\0')) {
    throw new Error(`Access denied: invalid entry name "${baseName}"`)
  }

  let realParent: string
  try {
    realParent = await realpathAllowingMissing(parentDir)
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
    real = await realpathAllowingMissing(filePath)
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
  const safeTarget = await normalizeCreationTarget(filePath)
  // A creation/write target whose FINAL segment is an existing symlink is
  // rejected outright: normalizeCreationTarget realpaths only the parent chain
  // (the basename may not exist yet), so a symlink basename would otherwise let
  // a write follow the link out of the allowed root. Mirrors statEntry /
  // removeEntry, which likewise refuse to operate through a symlink.
  const targetStat = await fs.lstat(safeTarget).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null // target doesn't exist yet — fine
    throw err
  })
  if (targetStat?.isSymbolicLink()) {
    throw new Error(`Access denied: "${filePath}" is a symbolic link`)
  }
  // Only the realpath-resolved target counts. Checking the lexical
  // (pre-resolution) form as an alternative would defeat the parent symlink
  // resolution above: a symlinked dir inside a root pointing outside it would
  // pass on its lexical form.
  if (isWithinAllowedRoots(safeTarget, scopeId)) {
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
