import { describe, it, expect } from 'vitest'
import { parseEvent, groupEvents, byteOffsetToCharOffset, type RgEvent } from './ripgrepParser'

const begin = (p: string): RgEvent => ({ type: 'begin', data: { path: { text: p } } })
const end = (p: string): RgEvent => ({ type: 'end', data: { path: { text: p } } })
const match = (
  p: string,
  lineNumber: number,
  text: string,
  submatches: { start: number; end: number }[],
): RgEvent => ({
  type: 'match',
  data: {
    path: { text: p },
    lines: { text: text + '\n' },
    line_number: lineNumber,
    submatches: submatches.map((s) => ({ match: { text: text.slice(s.start, s.end) }, ...s })),
  },
})
const context = (p: string, lineNumber: number, text: string): RgEvent => ({
  type: 'context',
  data: { path: { text: p }, lines: { text: text + '\n' }, line_number: lineNumber, submatches: [] },
})

describe('byteOffsetToCharOffset', () => {
  it('is identity for ASCII', () => {
    expect(byteOffsetToCharOffset('const x = 1', 6)).toBe(6)
  })

  it('accounts for multibyte characters before the offset', () => {
    // "héllo": 'é' is 2 bytes, so byte offset 3 == char offset 2.
    expect(byteOffsetToCharOffset('héllo', 3)).toBe(2)
  })

  it('clamps to the string bounds', () => {
    expect(byteOffsetToCharOffset('abc', -5)).toBe(0)
    expect(byteOffsetToCharOffset('abc', 999)).toBe(3)
  })
})

describe('parseEvent', () => {
  it('parses a valid match event', () => {
    const line = JSON.stringify({ type: 'match', data: { path: { text: 'a.ts' } } })
    expect(parseEvent(line)?.type).toBe('match')
  })

  it('returns null for blank lines, bad JSON, and unknown types', () => {
    expect(parseEvent('')).toBeNull()
    expect(parseEvent('   ')).toBeNull()
    expect(parseEvent('{not json')).toBeNull()
    expect(parseEvent(JSON.stringify({ type: 'mystery' }))).toBeNull()
    expect(parseEvent(JSON.stringify({ data: {} }))).toBeNull()
  })
})

describe('groupEvents', () => {
  it('groups a begin..end block into one file with match lines', () => {
    const files = groupEvents([
      begin('a.ts'),
      match('a.ts', 10, 'const foo = 1', [{ start: 6, end: 9 }]),
      match('a.ts', 20, 'foo()', [{ start: 0, end: 3 }]),
      end('a.ts'),
    ])
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('a.ts')
    expect(files[0].lines).toHaveLength(2)
    expect(files[0].matchCount).toBe(2)
    expect(files[0].lines[0].ranges).toEqual([{ start: 6, end: 9 }])
  })

  it('counts each submatch on a line', () => {
    const files = groupEvents([
      begin('a.ts'),
      match('a.ts', 1, 'foo foo foo', [
        { start: 0, end: 3 },
        { start: 4, end: 7 },
        { start: 8, end: 11 },
      ]),
      end('a.ts'),
    ])
    expect(files[0].matchCount).toBe(3)
    expect(files[0].lines[0].ranges).toHaveLength(3)
  })

  it('keeps context lines with empty ranges and does not count them', () => {
    const files = groupEvents([
      begin('a.ts'),
      context('a.ts', 9, 'before'),
      match('a.ts', 10, 'foo', [{ start: 0, end: 3 }]),
      context('a.ts', 11, 'after'),
      end('a.ts'),
    ])
    expect(files[0].lines).toHaveLength(3)
    expect(files[0].matchCount).toBe(1)
    const contextLines = files[0].lines.filter((l) => l.ranges.length === 0)
    expect(contextLines.map((l) => l.text)).toEqual(['before', 'after'])
  })

  it('drops files that produced no matches and ignores summary events', () => {
    const files = groupEvents([
      begin('empty.ts'),
      context('empty.ts', 1, 'just context'),
      end('empty.ts'),
      { type: 'summary', data: {} },
    ])
    expect(files).toHaveLength(0)
  })

  it('finalizes a file left open with no trailing end (cap/timeout kill)', () => {
    const files = groupEvents([
      begin('a.ts'),
      match('a.ts', 1, 'foo', [{ start: 0, end: 3 }]),
      // no end event — ripgrep was killed mid-file
    ])
    expect(files).toHaveLength(1)
    expect(files[0].matchCount).toBe(1)
  })

  it('leaves relativePath empty for the caller to fill', () => {
    const files = groupEvents([
      begin('/abs/a.ts'),
      match('/abs/a.ts', 1, 'foo', [{ start: 0, end: 3 }]),
      end('/abs/a.ts'),
    ])
    expect(files[0].relativePath).toBe('')
  })
})
