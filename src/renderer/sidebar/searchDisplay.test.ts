import { describe, it, expect } from 'vitest'
import { trimLeading, trimForDisplay } from './searchDisplay'

describe('trimLeading', () => {
  it('strips leading whitespace and shifts ranges', () => {
    const out = trimLeading('    const x = 1', [{ start: 10, end: 11 }])
    expect(out.text).toBe('const x = 1')
    expect(out.ranges).toEqual([{ start: 6, end: 7 }])
  })

  it('is a no-op when there is no leading whitespace', () => {
    const out = trimLeading('foo', [{ start: 0, end: 3 }])
    expect(out.text).toBe('foo')
    expect(out.ranges).toEqual([{ start: 0, end: 3 }])
  })
})

describe('trimForDisplay', () => {
  it('keeps a near-start match as-is (no ellipsis)', () => {
    const out = trimForDisplay('const foo = 1', [{ start: 6, end: 9 }])
    expect(out.ellipsis).toBe(false)
    expect(out.text).toBe('const foo = 1')
    expect(out.ranges[0]).toEqual({ start: 6, end: 9 })
  })

  it('start-trims a far-right match so it stays visible, flagging ellipsis', () => {
    // Match at column 40; should trim to keep MAX_PREFIX(8) chars before it.
    const text = 'x'.repeat(40) + 'MATCH' + 'y'.repeat(10)
    const out = trimForDisplay(text, [{ start: 40, end: 45 }])
    expect(out.ellipsis).toBe(true)
    // The match now sits 8 chars from the start of the trimmed text.
    expect(out.ranges[0]).toEqual({ start: 8, end: 13 })
    expect(out.text.slice(out.ranges[0].start, out.ranges[0].end)).toBe('MATCH')
  })

  it('also strips leading whitespace before considering the prefix', () => {
    const out = trimForDisplay('        foo', [{ start: 8, end: 11 }])
    // After whitespace trim the match is at 0 → no ellipsis needed.
    expect(out.ellipsis).toBe(false)
    expect(out.text).toBe('foo')
    expect(out.ranges[0]).toEqual({ start: 0, end: 3 })
  })

  it('returns no ranges (and no ellipsis) for a context line', () => {
    const out = trimForDisplay('   some context', [])
    expect(out.ellipsis).toBe(false)
    expect(out.ranges).toHaveLength(0)
  })
})
