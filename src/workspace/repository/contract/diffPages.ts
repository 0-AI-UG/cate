import type { GitDiffHunk } from './types'

/** Bound both the rendered rows and the payload of a single diff page. */
export const DIFF_PAGE_LINES = 200

export interface DiffPage {
  hunks: GitDiffHunk[]
  page: number
  pageCount: number
  totalLines: number
}

export function diffPage(hunks: readonly GitDiffHunk[], requestedPage = 0): DiffPage {
  const totalLines = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  const pageCount = Math.max(1, Math.ceil(totalLines / DIFF_PAGE_LINES))
  const page = Math.max(0, Math.min(pageCount - 1, Math.floor(requestedPage) || 0))
  const start = page * DIFF_PAGE_LINES
  const end = start + DIFF_PAGE_LINES
  let offset = 0
  const selected: GitDiffHunk[] = []
  for (const hunk of hunks) {
    const from = Math.max(0, start - offset)
    const to = Math.min(hunk.lines.length, end - offset)
    if (from === 0 && to === hunk.lines.length) selected.push(hunk)
    else if (from < to) {
      const lines = hunk.lines.slice(from, to)
      const oldStart = lines.find((line) => line.oldLine !== null)?.oldLine ?? hunk.oldStart
      const newStart = lines.find((line) => line.newLine !== null)?.newLine ?? hunk.newStart
      selected.push({ ...hunk, lines, oldStart, newStart,
        oldLines: lines.filter((line) => line.oldLine !== null).length,
        newLines: lines.filter((line) => line.newLine !== null).length })
    }
    offset += hunk.lines.length
    if (offset >= end) break
  }
  return { hunks: selected, page, pageCount, totalLines }
}
