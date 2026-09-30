// =============================================================================
// terminalDrop: pure helper for formatting dropped file references into text
// pasted at the terminal prompt. A search-line drag carries a line number,
// rendered as path:line (a VS Code-style reference). Unit-testable.
// =============================================================================

export interface DroppedRef {
  path: string
  /** 1-based line for a search-line drag; omitted for plain file drags. */
  line?: number
}

/** Shell-escape a single path (or path:line) for safe pasting. */
function shellEscape(p: string): string {
  if (/^[a-zA-Z0-9_./:@~=-]+$/.test(p)) return p
  return "'" + p.replace(/'/g, "'\\''") + "'"
}

/** Join dropped refs into a space-separated, shell-escaped string. */
export function formatTerminalPaste(refs: DroppedRef[]): string {
  return refs
    .map((r) => shellEscape(r.line ? `${r.path}:${r.line}` : r.path))
    .join(' ')
}

// In-app file drags (file tree, search results). The MIME names are the ones
// the client's drag sources write.
const FILE_MIME = 'application/cate-file'
const FILES_MIME = 'application/cate-files'
const FILE_LINE_MIME = 'application/cate-file-line'

export function isFileDrag(types: readonly string[]): boolean {
  return types.includes(FILE_MIME) || types.includes(FILES_MIME)
}

/** The files an in-app drag carries; a search-line drag also its line. */
export function droppedRefs(data: { getData(format: string): string }): DroppedRef[] {
  let paths: string[] = []
  try {
    const list = JSON.parse(data.getData(FILES_MIME) || 'null')
    if (Array.isArray(list)) paths = list.filter((p): p is string => typeof p === 'string')
  } catch { /* malformed payload */ }
  if (paths.length === 0 && data.getData(FILE_MIME)) paths = [data.getData(FILE_MIME)]
  let location: { path?: unknown; line?: unknown } | null = null
  try { location = JSON.parse(data.getData(FILE_LINE_MIME) || 'null') } catch { /* malformed payload */ }
  return paths.map((path) =>
    location?.path === path && typeof location.line === 'number' ? { path, line: location.line } : { path })
}
