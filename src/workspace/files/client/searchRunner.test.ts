import { describe, it, expect } from 'vitest'
import type { SearchFileResult } from '../contract'
import { mergeSearchResults } from './searchRunner'

const file = (path: string, lines = 1): SearchFileResult => ({
  path,
  relativePath: path,
  lines: Array.from({ length: lines }, (_, i) => ({ line: i + 1, text: 'x', ranges: [{ start: 0, end: 1 }] })),
  matchCount: lines,
})

describe('mergeSearchResults', () => {
  it('appends new files', () => {
    const out = mergeSearchResults([file('a.ts')], [file('b.ts')])
    expect(out.map((f) => f.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('dedupes by path (first wins)', () => {
    const out = mergeSearchResults([file('a.ts', 1)], [file('a.ts', 9), file('c.ts')])
    expect(out.map((f) => f.path)).toEqual(['a.ts', 'c.ts'])
    expect(out[0].matchCount).toBe(1) // original kept
  })

  it('returns the same array reference for an empty batch', () => {
    const existing = [file('a.ts')]
    expect(mergeSearchResults(existing, [])).toBe(existing)
  })
})
