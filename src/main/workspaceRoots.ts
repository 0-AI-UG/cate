import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import log from './logger'

export async function resolveTrustedWorkspaceRoot(rootPath: string): Promise<string | null> {
  try {
    const resolved = path.resolve(rootPath)
    let realPath: string
    try {
      realPath = await fs.realpath(resolved)
    } catch {
      // WinFsp disk-mode mounts can reject the native resolver while Node's
      // JS implementation can still canonicalize the same directory safely.
      realPath = fsSync.realpathSync(resolved)
    }
    const stat = await fs.stat(realPath)
    if (!stat.isDirectory()) {
      log.warn('workspaceRoots: rootPath is not a directory, rejecting: %s', rootPath)
      return null
    }
    // Preserve the user-selected form (for example X:\project). The path
    // validator registers both this lexical form and realPath's UNC alias.
    return resolved
  } catch {
    log.warn('workspaceRoots: rootPath does not exist or is unreadable, rejecting: %s', rootPath)
    return null
  }
}
