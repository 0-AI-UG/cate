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
 * Validates that a file path is within an allowed root directory.
 * Returns the normalized absolute path if valid, throws if not.
 */
export function validatePath(filePath: string): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Access denied: invalid path')
  }

  const normalized = path.resolve(filePath)
  if (isWithinAllowedRoots(normalized)) {
    return normalized
  }

  throw new Error(`Access denied: path "${filePath}" is outside allowed directories`)
}

/**
 * Validates that a file path is within an allowed root directory AND that its
 * fully-resolved (symlink-free) real path is also within an allowed root.
 * This prevents TOCTOU attacks where a symlink inside a workspace root points
 * to a sensitive path outside it (e.g. /etc/passwd).
 *
 * Returns the real absolute path if valid, throws if not.
 */
export async function validatePathStrict(filePath: string): Promise<string> {
  // First do the cheap lexical check so we fail fast on obviously bad input.
  validatePath(filePath)

  let real: string
  try {
    real = await fs.realpath(filePath)
  } catch (err) {
    throw new Error(`Access denied: cannot resolve real path for "${filePath}": ${err}`)
  }

  if (isWithinAllowedRoots(real)) {
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
  if (hasScopedWriteAllowance(ownerWindowId, safeTarget)) {
    return safeTarget
  }
  throw new Error(`Access denied: resolved parent "${path.dirname(safeTarget)}" is outside allowed directories`)
}

/**
 * Validates a directory path for git/shell operations.
 * Same as validatePath but specifically for cwd parameters.
 */
export function validateCwd(cwd: string): string {
  return validatePath(cwd)
}
