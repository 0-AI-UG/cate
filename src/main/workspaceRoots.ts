import fs from 'fs/promises'
import path from 'path'
import log from './logger'

export async function resolveTrustedWorkspaceRoot(rootPath: string): Promise<string | null> {
  try {
    const resolved = path.resolve(rootPath)
    const realPath = await fs.realpath(resolved)
    const stat = await fs.stat(realPath)
    if (!stat.isDirectory()) {
      log.warn('workspaceRoots: rootPath is not a directory, rejecting: %s', rootPath)
      return null
    }
    return realPath
  } catch {
    log.warn('workspaceRoots: rootPath does not exist or is unreadable, rejecting: %s', rootPath)
    return null
  }
}
