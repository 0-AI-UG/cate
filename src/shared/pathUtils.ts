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
  if (process.platform === 'win32') return joined.replace(/\//g, '\\')
  return joined
}
