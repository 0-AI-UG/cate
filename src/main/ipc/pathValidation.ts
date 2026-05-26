// =============================================================================
// Path validation — prevent path traversal and restrict filesystem access
// to registered workspace roots and the system temp directory.
// =============================================================================

import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const allowedRoots = new Set<string>()
const scopedWriteAllowances = new Map<number, Map<string, ReturnType<typeof setTimeout>>>()
const DEFAULT_WRITE_ALLOWANCE_TTL_MS = 60_000

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

export function addAllowedRoot(root: string): void {
  allowedRoots.add(path.resolve(root))
}

export function removeAllowedRoot(root: string): void {
  allowedRoots.delete(path.resolve(root))
}

export function getAllowedRoots(): ReadonlySet<string> {
  return allowedRoots
}

function isWithinAllowedRoots(normalized: string): boolean {
  const tmpDir = path.resolve(os.tmpdir())
  if (normalized === tmpDir || normalized.startsWith(tmpDir + path.sep)) {
    return true
  }

  for (const root of allowedRoots) {
    if (normalized.startsWith(root + path.sep) || normalized === root) {
      return true
    }
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
  const timer = allowances?.get(safePath)
  if (timer) clearTimeout(timer)
  allowances?.delete(safePath)
  if (allowances && allowances.size === 0) {
    scopedWriteAllowances.delete(windowId)
  }
}

function hasScopedWriteAllowance(windowId: number | undefined, safePath: string): boolean {
  if (windowId == null) return false
  return scopedWriteAllowances.get(windowId)?.has(safePath) ?? false
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
  allowances.set(safePath, timer)
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
  set.add(safePath)
  persistentFileGrants.set(windowId, set)
  return safePath
}

function hasGrantedFile(windowId: number | undefined, normalized: string): boolean {
  if (windowId == null) return false
  return persistentFileGrants.get(windowId)?.has(normalized) ?? false
}

export function clearFileGrantsForWindow(windowId: number): void {
  persistentFileGrants.delete(windowId)
}

/**
 * Validates that a file path is within an allowed root directory or
 * persistently granted to the calling window. Returns the normalized
 * absolute path if valid, throws if not.
 */
export function validatePath(filePath: string, ownerWindowId?: number): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Access denied: invalid path')
  }

  const normalized = path.resolve(filePath)
  if (isWithinAllowedRoots(normalized)) {
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
export async function validatePathStrict(filePath: string, ownerWindowId?: number): Promise<string> {
  // First do the cheap lexical check so we fail fast on obviously bad input.
  validatePath(filePath, ownerWindowId)

  let real: string
  try {
    real = await fs.realpath(filePath)
  } catch (err) {
    throw new Error(`Access denied: cannot resolve real path for "${filePath}": ${err}`)
  }

  if (isWithinAllowedRoots(real)) {
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
export async function validatePathForCreation(filePath: string, ownerWindowId?: number): Promise<string> {
  const normalized = path.resolve(filePath)
  const safeTarget = await normalizeCreationTarget(filePath)
  if (isWithinAllowedRoots(normalized) || isWithinAllowedRoots(safeTarget)) {
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
export function validateCwd(cwd: string, ownerWindowId?: number): string {
  return validatePath(cwd, ownerWindowId)
}
