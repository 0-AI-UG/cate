// Links in a PTY's screen (`process.links`): web URLs and file paths
// (`src/foo.ts:12:5`, as compilers, linters and tests print them). A link
// runs over rows only where the terminal soft-wrapped it (xterm's
// `isWrapped`): a newline the program wrote ends it, as in every terminal,
// since nothing on the screen tells it from a program wrapping its own text.
// Programs that name their links (OSC 8) get them whole however they wrap,
// in the view's terminal (see `../contract/links`).

import path from 'node:path'
import type { TerminalLinkTarget } from '../contract'

/** xterm's web-links URL pattern. */
const URL_RE = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g

// A path token: an optional prefix (a Windows drive `C:\` / `C:/`, a leading
// separator, POSIX `/abs` or UNC `\`, or a `./` / `../` dot prefix), then one
// or more `segment<sep>` parts (a bare filename without a separator is NOT
// matched), then a `name.ext` filename, then an optional `:line(:col)?`.
// Requiring a separator and an extension keeps false positives low; the file
// check is the final gate.
const FILE_RE =
  /((?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])?(?:[\w.@+-]+[\\/])+[\w.@+-]+\.[A-Za-z]\w*)(?::(\d+)(?::(\d+))?)?/g

export type TextLink =
  | { kind: 'url'; url: string; start: number; end: number }
  /** `path` as written: absolute or relative to the terminal's cwd. */
  | { kind: 'file'; path: string; line?: number; column?: number; start: number; end: number }

/** Every URL and path-shaped token in `text`; `start`/`end` are offsets. A
 *  path inside a URL is part of the URL. */
export function findTextLinks(text: string): TextLink[] {
  const links: TextLink[] = []
  for (const m of text.matchAll(URL_RE)) {
    // A URL a program cut short for display is not one to open.
    if (m[0].endsWith('…')) continue
    links.push({ kind: 'url', url: m[0], start: m.index, end: m.index + m[0].length })
  }
  const inUrl = (start: number, end: number) => links.some((link) => start < link.end && end > link.start)
  for (const m of text.matchAll(FILE_RE)) {
    const start = m.index
    const end = start + m[0].length
    if (inUrl(start, end)) continue
    links.push({
      kind: 'file',
      path: m[1],
      ...(m[2] ? { line: Number(m[2]) } : {}),
      ...(m[3] ? { column: Number(m[3]) } : {}),
      start,
      end,
    })
  }
  return links.sort((a, b) => a.start - b.start)
}

/** The cells of xterm's buffer the links are read from. */
export interface WrappedBuffer {
  getLine(y: number): BufferRow | undefined
}

export interface BufferRow {
  readonly isWrapped: boolean
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined
}

/** A logical line: the text of a row and the rows wrapped onto it, and
 *  where each character of the text sits (0-based column, row, cell width). */
export interface LogicalLine {
  text: string
  cells: { x: number; y: number; width: number }[]
}

/** Rows of a logical line searched in either direction from the hovered row. */
const MAX_WRAPPED_ROWS = 32

/** The logical line row `y` (0-based) belongs to, in a terminal `cols` wide:
 *  the row and the rows the terminal soft-wrapped it onto. */
export function logicalLineAt(buffer: WrappedBuffer, y: number, cols: number): LogicalLine | null {
  if (!buffer.getLine(y)) return null
  const softWraps = (row: number) => !!buffer.getLine(row + 1)?.isWrapped
  let first = y
  while (first > 0 && y - first < MAX_WRAPPED_ROWS && buffer.getLine(first)?.isWrapped) first--
  let last = y
  while (last - y < MAX_WRAPPED_ROWS && softWraps(last)) last++
  let text = ''
  const cells: LogicalLine['cells'] = []
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row)
    if (!line) break
    const wraps = row < last
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x)
      const width = cell?.getWidth() ?? 1
      // The second half of a wide character.
      if (width === 0) continue
      const chars = cell?.getChars() ?? ''
      // A wide character that did not fit leaves the row's last cell empty.
      if (!chars && wraps && x === cols - 1) continue
      for (const unit of chars || ' ') {
        text += unit
        for (let j = 0; j < unit.length; j++) cells.push({ x, y: row, width })
      }
    }
  }
  return { text, cells }
}

/** A link on the screen: cells 0-based, `end` past its last cell. */
export interface ScreenLink {
  target: TerminalLinkTarget
  text: string
  start: { x: number; y: number }
  end: { x: number; y: number }
}

/** The links on row `y` (0-based) of a screen `cols` wide: every URL, and
 *  every path that names a file (`isFile`), relative ones against `base`. */
export async function rowLinks(
  buffer: WrappedBuffer,
  cols: number,
  y: number,
  base: string,
  isFile: (path: string) => Promise<boolean>,
): Promise<ScreenLink[]> {
  const line = logicalLineAt(buffer, y, cols)
  if (!line) return []
  const links = await Promise.all(findTextLinks(line.text).map(async (link): Promise<ScreenLink | null> => {
    const from = line.cells[link.start]
    const to = line.cells[link.end - 1]
    // Each row of a wrapped line asks; answer with the links on this row.
    if (from.y > y || to.y < y) return null
    const shown = { text: line.text.slice(link.start, link.end), start: { x: from.x, y: from.y }, end: { x: to.x + to.width, y: to.y } }
    if (link.kind === 'url') return { target: { kind: 'url', url: link.url }, ...shown }
    const file = path.resolve(base, link.path)
    if (!(await isFile(file).catch(() => false))) return null
    return { target: { kind: 'file', path: file, ...(link.line ? { line: link.line } : {}), ...(link.column ? { column: link.column } : {}) }, ...shown }
  }))
  return links.filter((link): link is ScreenLink => link !== null)
}
