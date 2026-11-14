import { expect, it } from 'vitest'
import { DIFF_PAGE_LINES, diffPage } from './diffPages'
import type { GitDiffHunk } from './types'

const hunk = (start: number, count: number): GitDiffHunk => ({
  header: '@@', oldStart: start, oldLines: count, newStart: start, newLines: count,
  lines: Array.from({ length: count }, (_, index) => ({ kind: 'context', text: `line ${start + index}`, oldLine: start + index, newLine: start + index })),
})

it('bounds pages across hunk boundaries without losing lines or their original numbers', () => {
  const hunks = [hunk(1, 150), hunk(200, 500)]
  const pages = Array.from({ length: 4 }, (_, page) => diffPage(hunks, page))
  expect(pages.map((page) => page.hunks.reduce((sum, part) => sum + part.lines.length, 0))).toEqual([200, 200, 200, 50])
  expect(pages.flatMap((page) => page.hunks.flatMap((part) => part.lines))).toEqual(hunks.flatMap((part) => part.lines))
  expect(pages[1].hunks[0]).toMatchObject({ oldStart: 250, newStart: 250, oldLines: DIFF_PAGE_LINES, newLines: DIFF_PAGE_LINES })
})

it('clamps pages after a selection shrinks and handles empty diffs', () => {
  expect(diffPage([], 99)).toEqual({ hunks: [], page: 0, pageCount: 1, totalLines: 0 })
  expect(diffPage([hunk(1, 220)], 99)).toMatchObject({ page: 1, pageCount: 2, totalLines: 220 })
  expect(diffPage([hunk(1, 220)], -1).page).toBe(0)
})
