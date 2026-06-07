// =============================================================================
// ChatDiffView — inline diff rendering for file-edit tool calls. Builds a
// line-oriented diff (LCS for before/after, naive for find/replace blocks) and
// renders it with +/- gutters and line numbers.
// =============================================================================

import { useMemo } from 'react'
import type { DiffInfo } from './agentStore'

interface DiffLine {
  kind: 'context' | 'add' | 'del'
  text: string
}

function buildDiffLines(diff: DiffInfo): DiffLine[] {
  if (diff.edits && diff.edits.length > 0) {
    const out: DiffLine[] = []
    diff.edits.forEach((e, i) => {
      if (i > 0) out.push({ kind: 'context', text: '' })
      for (const l of e.oldString.split('\n')) out.push({ kind: 'del', text: l })
      for (const l of e.newString.split('\n')) out.push({ kind: 'add', text: l })
    })
    return out
  }
  if (diff.oldString != null || diff.newString != null) {
    const oldLines = (diff.oldString ?? '').split('\n')
    const newLines = (diff.newString ?? '').split('\n')
    const out: DiffLine[] = []
    for (const l of oldLines) out.push({ kind: 'del', text: l })
    for (const l of newLines) out.push({ kind: 'add', text: l })
    return out
  }
  if (diff.before != null && diff.after != null) {
    return lineDiff(diff.before, diff.after)
  }
  if (diff.after != null) {
    return diff.after.split('\n').map((t) => ({ kind: 'add' as const, text: t }))
  }
  return []
}

function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const m = a.length
  const n = b.length
  if (m * n > 250_000) {
    return [
      ...a.map((t) => ({ kind: 'del' as const, text: t })),
      ...b.map((t) => ({ kind: 'add' as const, text: t })),
    ]
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ kind: 'context', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: 'del', text: a[i] }); i++ }
    else { out.push({ kind: 'add', text: b[j] }); j++ }
  }
  while (i < m) { out.push({ kind: 'del', text: a[i++] }) }
  while (j < n) { out.push({ kind: 'add', text: b[j++] }) }
  return out
}

export function DiffView({ diff }: { diff: DiffInfo }) {
  const lines = useMemo(() => buildDiffLines(diff), [diff])
  let oldLine = 1
  let newLine = 1
  return (
    <div className="max-h-[280px] overflow-auto font-mono text-[11px] leading-[1.45] select-text cursor-text">
      {lines.map((l, i) => {
        let ln: string
        if (l.kind === 'del') { ln = String(oldLine++); }
        else if (l.kind === 'add') { ln = String(newLine++); }
        else { ln = String(oldLine++); newLine++; }
        return (
          <div
            key={i}
            className={`flex ${
              l.kind === 'add'
                ? 'bg-diff-add'
                : l.kind === 'del'
                ? 'bg-diff-del'
                : ''
            }`}
          >
            <span className="w-5 text-right pr-1.5 select-none text-muted/30 shrink-0">{ln}</span>
            <span className={`w-3 text-center select-none shrink-0 ${
              l.kind === 'add' ? 'text-diff-add' : l.kind === 'del' ? 'text-diff-del' : 'text-transparent'
            }`}>
              {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}
            </span>
            <span className={`whitespace-pre-wrap break-words flex-1 pr-2 ${
              l.kind === 'add'
                ? 'text-diff-add'
                : l.kind === 'del'
                ? 'text-diff-del line-through'
                : 'text-primary/50'
            }`}>{l.text || ' '}</span>
          </div>
        )
      })}
    </div>
  )
}
