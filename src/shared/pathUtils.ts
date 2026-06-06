/**
 * Canonical key for comparing two absolute filesystem paths that may have been
 * produced by different sources. On Windows those sources disagree: git (e.g.
 * `git worktree list`) emits forward slashes (`C:/proj`) while Electron's folder
 * picker and Node yield native backslashes (`C:\proj`), and the filesystem is
 * case-insensitive — so a raw `===` between the two fails. This normalizes
 * separators (and lower-cases Windows-style paths) so equality holds.
 *
 * The platform is derived from the path itself — a drive letter or any
 * backslash means Windows — because this also runs in the renderer, where there
 * is no Node `process` global (matching `toAbsolutePath` below).
 */
export function pathKey(p: string): string {
  const isWindows = /^[A-Za-z]:/.test(p) || p.includes('\\')
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return isWindows ? norm.toLowerCase() : norm
}

export function toRelativePath(absPath: string, rootPath: string): string {
  const normAbs = absPath.replace(/\\/g, '/')
  const normRoot = rootPath.replace(/\\/g, '/').replace(/\/$/, '')
  if (!normAbs.startsWith(normRoot + '/')) return absPath
  return normAbs.slice(normRoot.length + 1)
}

export function toAbsolutePath(relPath: string, rootPath: string): string {
  if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) return relPath
  const normRoot = rootPath.replace(/\\/g, '/').replace(/\/$/, '')
  const normRel = relPath.replace(/\\/g, '/')
  const joined = normRoot + '/' + normRel
  // Derive the platform from the root path itself rather than `process.platform`:
  // this helper also runs in the renderer (workspace restore), where there is no
  // Node `process` global — referencing it there throws "process is not defined".
  const isWindowsRoot = /^[A-Za-z]:/.test(rootPath) || rootPath.includes('\\')
  if (isWindowsRoot) return joined.replace(/\//g, '\\')
  return joined
}
