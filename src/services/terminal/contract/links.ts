// Links in a terminal's output. The runtime finds them on its screen of the
// PTY (`process.links`): web URLs and file paths that exist, also where a
// link runs over rows (soft wraps, and a program's own word wrap). A program
// that names its links itself (OSC 8) gets them exactly in the view's
// terminal, which reads the target with `osc8Target`. Pure.

/** What a link opens; a client hands it to `openLink`. */
export type TerminalLinkTarget =
  | { kind: 'url'; url: string }
  /** An absolute path; `line` and `column` are 1-based. */
  | { kind: 'file'; path: string; line?: number; column?: number }

/** A cell of the screen: `x` the 0-based column, `row` the line counted up
 *  from the buffer's last line (0). Views keep different scrollbacks of the
 *  same output, so they agree on rows counted from the end. */
export interface TerminalCell {
  x: number
  row: number
}

export interface TerminalLinksParams {
  id: string
  /** The row asked about. */
  row: number
  /** The row's text as the view shows it (trailing blanks trimmed): a view
   *  behind or ahead of the runtime's screen gets no links for it. */
  text: string
}

export interface TerminalLink {
  target: TerminalLinkTarget
  /** The link's text as shown. */
  text: string
  start: TerminalCell
  /** The cell past the link's last one, on the link's last row. */
  end: TerminalCell
}

/** The target of an OSC 8 hyperlink: a web URL, or a `file://` URI naming a
 *  file (a `#L12` or `:12:5` suffix names the line). Null for anything else. */
export function osc8Target(uri: string): TerminalLinkTarget | null {
  let url: URL
  try { url = new URL(uri) } catch { return null }
  if (url.protocol === 'http:' || url.protocol === 'https:') return { kind: 'url', url: uri }
  if (url.protocol !== 'file:') return null
  let path: string
  try { path = decodeURIComponent(url.pathname) } catch { return null }
  // `file:///C:/x` names `C:/x`.
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
  const suffix = /:(\d+)(?::(\d+))?$/.exec(path)
  if (suffix) path = path.slice(0, suffix.index)
  const hash = /^#L(\d+)(?:C(\d+))?$/.exec(url.hash)
  const line = suffix?.[1] ?? hash?.[1]
  const column = suffix?.[2] ?? hash?.[2]
  return {
    kind: 'file',
    path,
    ...(line ? { line: Number(line) } : {}),
    ...(column ? { column: Number(column) } : {}),
  }
}
