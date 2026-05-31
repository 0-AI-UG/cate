// =============================================================================
// ripgrepParser — pure helpers to parse ripgrep's `--json` event stream into
// per-file search results. No I/O, so it is fully unit-testable.
//
// ripgrep emits one JSON object per line. The event types we care about:
//   begin   — start of matches in a file
//   match   — a matching line (with submatch byte offsets)
//   context — a surrounding context line (only when --context is used)
//   end     — end of a file's matches
//   summary — overall stats (ignored here)
// =============================================================================

import type { SearchFileResult, SearchResultLine, SearchMatchRange } from '../../shared/types'

/** Longest line text we keep; longer lines are truncated for display. */
const MAX_LINE_LENGTH = 2000

interface RgText {
  text?: string
  bytes?: string // base64, for non-UTF8 content
}

interface RgSubmatch {
  match: RgText
  start: number // byte offset into the line bytes
  end: number   // byte offset into the line bytes (exclusive)
}

interface RgMatchData {
  path: RgText
  lines: RgText
  line_number?: number
  submatches?: RgSubmatch[]
}

export type RgEvent =
  | { type: 'begin'; data: { path: RgText } }
  | { type: 'match'; data: RgMatchData }
  | { type: 'context'; data: RgMatchData }
  | { type: 'end'; data: { path: RgText } }
  | { type: 'summary'; data: unknown }

const KNOWN_TYPES = new Set(['begin', 'match', 'context', 'end', 'summary'])

/** Parse a single line of ripgrep `--json` output. Returns null for blank lines,
 *  malformed JSON, or unknown event types. */
export function parseEvent(line: string): RgEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (
    !obj ||
    typeof obj !== 'object' ||
    typeof (obj as { type?: unknown }).type !== 'string' ||
    !KNOWN_TYPES.has((obj as { type: string }).type)
  ) {
    return null
  }
  return obj as RgEvent
}

/** Resolve an RgText to a string, decoding base64 bytes when `text` is absent. */
function textOf(t: RgText | undefined): string {
  if (!t) return ''
  if (typeof t.text === 'string') return t.text
  if (typeof t.bytes === 'string') {
    try {
      return Buffer.from(t.bytes, 'base64').toString('utf-8')
    } catch {
      return ''
    }
  }
  return ''
}

/** Convert a byte offset into a UTF-8 string to its character (code-unit) offset.
 *  ripgrep emits submatch offsets aligned to character boundaries, so the slice
 *  below never splits a multi-byte sequence in practice. */
export function byteOffsetToCharOffset(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0
  const buf = Buffer.from(text, 'utf-8')
  if (byteOffset >= buf.length) return text.length
  return buf.subarray(0, byteOffset).toString('utf-8').length
}

/** Build a SearchResultLine from a match/context event. Context lines (no
 *  submatches) get an empty `ranges` array. */
function lineFromEvent(data: RgMatchData): SearchResultLine | null {
  const lineNumber = data.line_number
  if (typeof lineNumber !== 'number') return null

  // ripgrep includes the trailing newline in lines.text; strip it for display.
  let text = textOf(data.lines).replace(/\r?\n$/, '')

  const ranges: SearchMatchRange[] = []
  for (const sm of data.submatches ?? []) {
    const start = byteOffsetToCharOffset(text, sm.start)
    const end = byteOffsetToCharOffset(text, sm.end)
    if (end > start) ranges.push({ start, end })
  }

  // Truncate very long lines, dropping/clamping ranges past the cap.
  if (text.length > MAX_LINE_LENGTH) {
    text = text.slice(0, MAX_LINE_LENGTH)
    for (let i = ranges.length - 1; i >= 0; i--) {
      if (ranges[i].start >= MAX_LINE_LENGTH) ranges.splice(i, 1)
      else if (ranges[i].end > MAX_LINE_LENGTH) ranges[i].end = MAX_LINE_LENGTH
    }
  }

  return { line: lineNumber, text, ranges }
}

/**
 * Group a flat list of ripgrep events into per-file results, in the order files
 * were emitted. `matchCount` counts individual submatches (matching VS Code's
 * "N results" semantics). `relativePath` is left empty — the caller fills it in
 * once the search root is known.
 */
export function groupEvents(events: RgEvent[]): SearchFileResult[] {
  const files: SearchFileResult[] = []
  let current: SearchFileResult | null = null

  for (const ev of events) {
    switch (ev.type) {
      case 'begin':
        current = { path: textOf(ev.data.path), relativePath: '', lines: [], matchCount: 0 }
        break
      case 'match':
      case 'context': {
        if (!current) break
        const line = lineFromEvent(ev.data)
        if (line) {
          current.lines.push(line)
          current.matchCount += line.ranges.length
        }
        break
      }
      case 'end':
        if (current) {
          // Only keep files that actually had matches.
          if (current.matchCount > 0) files.push(current)
          current = null
        }
        break
      case 'summary':
      default:
        break
    }
  }

  // Finalize a file left open (no trailing `end`) — happens when ripgrep is
  // killed mid-file at the result cap or timeout. Don't drop its matches.
  if (current && current.matchCount > 0) files.push(current)

  return files
}
