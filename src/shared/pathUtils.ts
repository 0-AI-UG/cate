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
