// =============================================================================
// Path validation — prevent path traversal and restrict filesystem access
// to registered workspace roots and the system temp directory.
// =============================================================================

import path from 'path'
import os from 'os'

const allowedRoots = new Set<string>()

export function addAllowedRoot(root: string): void {
  allowedRoots.add(path.resolve(root))
}

export function removeAllowedRoot(root: string): void {
  allowedRoots.delete(path.resolve(root))
}

export function getAllowedRoots(): ReadonlySet<string> {
  return allowedRoots
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

  // Always allow temp directory access
  const tmpDir = os.tmpdir()
  if (normalized.startsWith(tmpDir + path.sep) || normalized === tmpDir) {
    return normalized
  }

  for (const root of allowedRoots) {
    if (normalized.startsWith(root + path.sep) || normalized === root) {
      return normalized
    }
  }

  throw new Error(`Access denied: path "${filePath}" is outside allowed directories`)
}

/**
 * Validates a directory path for git/shell operations.
 * Same as validatePath but specifically for cwd parameters.
 */
export function validateCwd(cwd: string): string {
  return validatePath(cwd)
}
