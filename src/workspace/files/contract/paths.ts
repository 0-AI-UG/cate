// Pure path helpers both sides use. The platform is read off the path itself
// (a drive letter or a backslash means Windows): clients have no `process`.

const isWindowsPath = (p: string): boolean => /^[A-Za-z]:/.test(p) || p.includes('\\')

/** Comparison key for two absolute paths from different sources (git emits
 *  `C:/proj`, Node `C:\proj`; Windows is case-insensitive). */
export function pathKey(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return isWindowsPath(p) ? norm.toLowerCase() : norm
}

/** True when `p` is `prefix` or lies beneath it. */
export function pathHasPrefix(p: string, prefix: string): boolean {
  if (p === prefix) return true
  if (!p.startsWith(prefix)) return false
  if (prefix.endsWith('/') || prefix.endsWith('\\')) return true
  const next = p.charCodeAt(prefix.length)
  return next === 47 /* / */ || next === 92 /* \ */
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
  const joined = normRoot + '/' + relPath.replace(/\\/g, '/')
  return isWindowsPath(rootPath) ? joined.replace(/\//g, '\\') : joined
}

/** The folder `p` is in, in the path's own style; '' when it has none. A
 *  client may show paths of a runtime on another OS, so never split on its
 *  own separator. */
export function parentDir(p: string): string {
  const cut = Math.max(p.lastIndexOf('/'), isWindowsPath(p) ? p.lastIndexOf('\\') : -1)
  if (cut < 0) return ''
  const dir = p.slice(0, cut || 1)
  return /^[A-Za-z]:$/.test(dir) ? `${dir}\\` : dir
}

/** `name` inside `dir`, with the separator `dir` uses. */
export function joinPath(dir: string, name: string): string {
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + name
  return dir + (isWindowsPath(dir) ? '\\' : '/') + name
}

/** Last non-empty segment, for display. */
export function pathDisplayName(p: string): string {
  const sep = isWindowsPath(p) ? /[\\/]/ : /\//
  return p.split(sep).filter(Boolean).pop() ?? ''
}

/** Path relative to `root` for display and the clipboard; the path itself when
 *  it is not under `root`. */
export function relativeDisplayPath(p: string, root: string): string {
  const norm = (value: string): string => (isWindowsPath(value) ? value.replace(/\\/g, '/') : value).replace(/\/+$/, '')
  const file = norm(p)
  const base = norm(root)
  if (base && file.startsWith(base + '/')) return file.slice(base.length + 1)
  return p
}

export type DocumentType = 'pdf' | 'docx' | 'image'

const DOCUMENT_EXTENSIONS: Record<string, DocumentType> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.gif': 'image',
  '.svg': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.ico': 'image',
  '.tiff': 'image',
  '.tif': 'image',
}

/** Files an editor previews instead of editing as text. */
export function getDocumentType(filePath: string): DocumentType | null {
  const dot = filePath.lastIndexOf('.')
  if (dot === -1) return null
  return DOCUMENT_EXTENSIONS[filePath.slice(dot).toLowerCase()] ?? null
}
