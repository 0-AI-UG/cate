import { useMemo } from 'react'
import type { GitDiffHunk, GitDiffLine } from '@workspace/repository/contract'
import { DiffRows } from './DiffRows'

function wordHighlight(text: string, other: string | undefined, enabled: boolean) {
  if (!enabled || other == null || text === other) return text || ' '
  let start = 0
  while (start < text.length && start < other.length && text[start] === other[start]) start++
  let end = 0
  while (end < text.length - start && end < other.length - start && text[text.length - 1 - end] === other[other.length - 1 - end]) end++
  const middleEnd = text.length - end
  return <>{text.slice(0, start)}<span className="bg-current/15 rounded-sm">{text.slice(start, middleEnd) || ' '}</span>{text.slice(middleEnd)}</>
}

interface Row { left?: GitDiffLine; right?: GitDiffLine }
function pairLines(lines: GitDiffLine[]): Row[] {
  const rows: Row[] = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (line.kind === 'delete') {
      const left: GitDiffLine[] = [], right: GitDiffLine[] = []
      while (lines[i]?.kind === 'delete') left.push(lines[i++])
      while (lines[i]?.kind === 'add') right.push(lines[i++])
      for (let n = 0; n < Math.max(left.length, right.length); n++) rows.push({ left: left[n], right: right[n] })
    } else { rows.push(line.kind === 'add' ? { right: line } : { left: line, right: line }); i++ }
  }
  return rows
}

function Cell({ line, other, side, wordDiff }: { line?: GitDiffLine; other?: GitDiffLine; side?: 'old' | 'new'; wordDiff: boolean }) {
  const kind = line?.kind
  return <div data-old-line={line?.oldLine ?? undefined} data-new-line={line?.newLine ?? undefined} className={`flex min-w-0 ${kind === 'add' ? 'bg-diff-add text-diff-add' : kind === 'delete' ? 'bg-diff-del text-diff-del' : 'text-secondary'}`}>
    {side !== 'new' && <span className="w-10 shrink-0 select-none pr-2 text-right text-muted">{line?.oldLine}</span>}
    {side !== 'old' && <span className="w-10 shrink-0 select-none pr-2 text-right text-muted">{line?.newLine}</span>}
    <span className="w-4 shrink-0 select-none">{kind === 'add' ? '+' : kind === 'delete' ? '-' : ' '}</span>
    <span className="min-w-0 flex-1 pr-3">{line ? wordHighlight(line.text, other?.text, wordDiff && (kind === 'add' || kind === 'delete')) : ' '}</span>
  </div>
}

type DiffRow = { header: string } | { line?: GitDiffLine; other?: GitDiffLine; left?: GitDiffLine; right?: GitDiffLine }

/** One virtualized row list for the entire file, including many small hunks. */
export function GitDiff({ hunks, split = false, wordDiff = true, wrap = false, numbered = true }: {
  hunks: GitDiffHunk[]
  split?: boolean
  wordDiff?: boolean
  wrap?: boolean
  numbered?: boolean
}) {
  const { rows, columns } = useMemo(() => {
    const rows: DiffRow[] = []
    let columns = 0
    for (const hunk of hunks) {
      rows.push({ header: hunk.header })
      const lines = numbered ? hunk.lines : hunk.lines.map((line) => ({ ...line, oldLine: null, newLine: null }))
      for (const line of lines) columns = Math.max(columns, line.text.length)
      const pairs = pairLines(lines)
      if (split) rows.push(...pairs)
      else {
        const others = new Map<GitDiffLine, GitDiffLine>()
        for (const { left, right } of pairs) if (left && right && left !== right) { others.set(left, right); others.set(right, left) }
        for (const line of lines) rows.push({ line, other: others.get(line) })
      }
    }
    return { rows, columns: columns * (split ? 2 : 1) }
  }, [hunks, numbered, split])
  return <DiffRows count={rows.length} columns={columns} wrap={wrap} renderRow={(index) => {
    const row = rows[index]
    if ('header' in row) return <div className="sticky top-0 z-[1] border-y border-subtle bg-surface-2 px-3 py-1 text-muted">{row.header}</div>
    if (!split) return <Cell line={row.line} other={row.other} wordDiff={wordDiff} />
    return <div className="grid grid-cols-2 divide-x divide-subtle"><Cell line={row.left} other={row.right} side="old" wordDiff={wordDiff} /><Cell line={row.right} other={row.left} side="new" wordDiff={wordDiff} /></div>
  }} />
}
