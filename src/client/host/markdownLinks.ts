// What a link or image in rendered markdown names (a file preview, an agent's
// reply): a web page, or a workspace file relative to the markdown file. Pure;
// each shell renders markdown its own way and hands the target to
// `openClickedLink`.

import type { LinkTarget } from './links'

/** The workspace path an image `src` or a link names, relative to the
 *  markdown file; null for web and inline images, which load as they are,
 *  and for a relative path without a markdown file to resolve it from. */
export function markdownPath(src: string, filePath?: string): string | null {
  if (/^(https?:|data:|blob:)/i.test(src)) return null
  let path = src.replace(/[?#].*$/, '')
  try { path = decodeURI(path) } catch { /* keep it as written */ }
  if (/^file:\/\//i.test(path)) path = path.slice('file://'.length).replace(/^\/([A-Za-z]:)/, '$1')
  if (path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path)) return path
  if (!filePath) return null
  const segments = filePath.replace(/\\/g, '/').split('/').slice(0, -1)
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '..') segments.pop()
    else if (part && part !== '.') segments.push(part)
  }
  return segments.join('/')
}

/** What a clicked `href` opens: a web page, or a file relative to the
 *  markdown file. Null for an in-page anchor and other schemes. */
export function markdownLinkTarget(href: string, filePath?: string): LinkTarget | null {
  if (/^https?:/i.test(href)) return { kind: 'url', url: href }
  if (href.startsWith('#') || (/^[a-z][a-z\d+.-]+:/i.test(href) && !/^file:/i.test(href))) return null
  const path = markdownPath(href, filePath)
  return path ? { kind: 'file', path } : null
}
