import { describe, it, expect } from 'vitest'
import { trimLeading } from './searchDisplay'

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

  it('keeps a far-right match intact (right-truncation is handled by CSS)', () => {
    const text = 'x'.repeat(40) + 'MATCH' + 'y'.repeat(10)
    const out = trimLeading(text, [{ start: 40, end: 45 }])
    expect(out.text).toBe(text) // no leading whitespace → unchanged
    expect(out.ranges[0]).toEqual({ start: 40, end: 45 })
  })
})
