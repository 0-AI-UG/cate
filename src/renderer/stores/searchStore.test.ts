import { describe, it, expect } from 'vitest'
import { createSearchStore, mergeFiles, lineKey } from './searchStore'
import type { SearchFileResult } from '../../shared/types'

const file = (path: string, lines = 1): SearchFileResult => ({
  path,
  relativePath: path,
  lines: Array.from({ length: lines }, (_, i) => ({ line: i + 1, text: 'x', ranges: [{ start: 0, end: 1 }] })),
  matchCount: lines,
})

describe('mergeFiles', () => {
  it('appends new files', () => {
    const out = mergeFiles([file('a.ts')], [file('b.ts')])
    expect(out.map((f) => f.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('dedupes by path (first wins)', () => {
    const out = mergeFiles([file('a.ts', 1)], [file('a.ts', 9), file('c.ts')])
    expect(out.map((f) => f.path)).toEqual(['a.ts', 'c.ts'])
    expect(out[0].matchCount).toBe(1) // original kept
  })

  it('returns the same array reference for an empty batch', () => {
    const existing = [file('a.ts')]
    expect(mergeFiles(existing, [])).toBe(existing)
  })
})

describe('searchStore actions', () => {
  it('beginSearch resets results and sets searching status', () => {
    const store = createSearchStore()
    store.getState().addBatch('s1', [file('a.ts')]) // ignored (no current id)
    store.getState().beginSearch('s1')
    expect(store.getState().status).toBe('searching')
    expect(store.getState().currentSearchId).toBe('s1')
    expect(store.getState().files).toHaveLength(0)
  })

  it('addBatch accepts matching searchId and ignores stale ones', () => {
    const store = createSearchStore()
    store.getState().beginSearch('s2')
    store.getState().addBatch('s2', [file('a.ts')])
    store.getState().addBatch('OLD', [file('b.ts')]) // stale → ignored
    expect(store.getState().files.map((f) => f.path)).toEqual(['a.ts'])
  })

  it('finishSearch records truncation + error for the current search only', () => {
    const store = createSearchStore()
    store.getState().beginSearch('s3')
    store.getState().finishSearch('STALE', { matches: 0, files: 0, truncated: true })
    expect(store.getState().status).toBe('searching') // stale ignored
    store.getState().finishSearch('s3', { matches: 5, files: 2, truncated: true }, 'bad regex')
    expect(store.getState().status).toBe('done')
    expect(store.getState().truncated).toBe(true)
    expect(store.getState().error).toBe('bad regex')
  })

  it('toggleCollapse flips a path in the collapsed set', () => {
    const store = createSearchStore()
    store.getState().toggleCollapse('a.ts')
    expect(store.getState().collapsed.has('a.ts')).toBe(true)
    store.getState().toggleCollapse('a.ts')
    expect(store.getState().collapsed.has('a.ts')).toBe(false)
  })

  it('dismissFile and dismissLine record dismissals', () => {
    const store = createSearchStore()
    store.getState().beginSearch('s4')
    store.getState().addBatch('s4', [file('a.ts'), file('b.ts')])
    store.getState().dismissFile('a.ts')
    store.getState().dismissLine('b.ts', 1)
    expect(store.getState().dismissedFiles.has('a.ts')).toBe(true)
    expect(store.getState().dismissedLines.has(lineKey('b.ts', 1))).toBe(true)
  })

  it('requestFocus bumps the focus token', () => {
    const store = createSearchStore()
    const before = store.getState().focusToken
    store.getState().requestFocus()
    expect(store.getState().focusToken).toBe(before + 1)
  })

  it('clearResults returns to idle with empty results', () => {
    const store = createSearchStore()
    store.getState().beginSearch('s5')
    store.getState().addBatch('s5', [file('a.ts')])
    store.getState().clearResults()
    expect(store.getState().status).toBe('idle')
    expect(store.getState().files).toHaveLength(0)
    expect(store.getState().currentSearchId).toBeNull()
  })
})
