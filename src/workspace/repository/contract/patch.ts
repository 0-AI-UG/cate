// Parses one file's unified diff into hunks. Pure: the runtime uses it for
// review diffs, the agents service for recorded changes.

import type { GitDiffHunk } from './types'

export function parseReviewPatch(raw: string): GitDiffHunk[] {
  const hunks: GitDiffHunk[] = []
  const metadata: string[] = []
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  let hunk: GitDiffHunk | null = null
  let oldLine = 0
  let newLine = 0
  for (const line of lines) {
    if (/^(old mode|new mode|new file mode|deleted file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to) /.test(line)) {
      metadata.push(line)
    }
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (!match) continue
      oldLine = Number(match[1])
      newLine = Number(match[3])
      hunk = {
        header: line,
        oldStart: oldLine,
        oldLines: Number(match[2] ?? 1),
        newStart: newLine,
        newLines: Number(match[4] ?? 1),
        lines: [],
      }
      hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (line.startsWith('\\ No newline at end of file')) {
      hunk.lines.push({ kind: 'meta', text: line, oldLine: null, newLine: null })
    } else if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: newLine++ })
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'delete', text: line.slice(1), oldLine: oldLine++, newLine: null })
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ kind: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ })
    }
  }
  if (metadata.length > 0) {
    hunks.unshift({
      header: 'File metadata',
      oldStart: 0,
      oldLines: 0,
      newStart: 0,
      newLines: 0,
      lines: metadata.map((text) => ({ kind: 'meta', text, oldLine: null, newLine: null })),
    })
  }
  return hunks
}
