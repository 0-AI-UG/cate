// =============================================================================
// terminalFileLinks — detect file paths in terminal output and resolve them.
//
// xterm's WebLinksAddon is URL-only, so file links (e.g. tsc/eslint/test output
// like `src/foo.ts:12:5`) need a custom link provider. This module is the pure,
// dependency-free core of that provider: it finds path-shaped tokens in a line
// of text, resolves them against the workspace root, and reports the click
// modifier. The provider (terminalFileLinkProvider) adds fs validation + xterm.
// =============================================================================

export interface FileMatch {
  /** The matched path as it appeared (absolute, or relative incl. ./ or ../). */
  path: string
  /** 1-based line number from a `:line` suffix, if present. */
  line?: number
  /** 1-based column from a `:line:col` suffix, if present. */
  column?: number
  /** Char offset of the match start within the line (for the xterm range). */
  start: number
  /** Char offset just past the match end. */
  end: number
}

// A path token: an optional ./ or ../ prefix (or a leading /), one or more
// `segment/` parts (so a bare filename without a slash is NOT matched), then a
// `name.ext` filename. An optional `:line(:col)?` suffix follows. Requiring a
// slash + extension keeps false positives low; fs validation is the final gate.
const FILE_LINK_RE =
  /((?:\.{0,2}\/)?(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z][\w]*)(?::(\d+)(?::(\d+))?)?/g

/** Find every path-shaped token (with optional :line:col) in a line of text. */
export function parseTerminalFileMatches(lineText: string): FileMatch[] {
  const out: FileMatch[] = []
  FILE_LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FILE_LINK_RE.exec(lineText)) !== null) {
    out.push({
      path: m[1],
      line: m[2] ? Number(m[2]) : undefined,
      column: m[3] ? Number(m[3]) : undefined,
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return out
}

/**
 * Resolve a matched path to an absolute path. Absolute paths are returned
 * unchanged; relative paths are joined onto the workspace root (a leading `./`
 * is dropped; `../` is kept for the fs layer to resolve).
 */
export function resolveCandidatePath(path: string, rootPath: string): string {
  if (path.startsWith('/')) return path
  const rel = path.startsWith('./') ? path.slice(2) : path
  return `${rootPath}/${rel}`
}

/** Cmd on macOS, Ctrl elsewhere — the modifier that activates a terminal link. */
export function isTerminalLinkModifier(
  e: { metaKey: boolean; ctrlKey: boolean },
  isMac: boolean,
): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}
