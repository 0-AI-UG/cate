// =============================================================================
// SearchResultsTree — VS Code-style grouped results: collapsible files, each
// with highlighted match lines (and optional context). Supports keyboard
// navigation, open-at-line, and dismissing a match or a whole file.
// =============================================================================

import React, { useEffect, useMemo, useState } from 'react'
import { CaretRight, CaretDown, File as FileIcon, X } from '@phosphor-icons/react'
import type { SearchFileResult, SearchMatchRange } from '../../shared/types'
import { useSearchStore, lineKey } from '../stores/searchStore'
import { useAppStore } from '../stores/appStore'
import { openFileAsPanel } from '../lib/fileRouting'
import { setPendingReveal } from '../lib/editorReveal'

/** Render a line's text with its match ranges highlighted. */
const Highlighted: React.FC<{ text: string; ranges: SearchMatchRange[] }> = ({ text, ranges }) => {
  if (ranges.length === 0) return <>{text}</>
  const parts: React.ReactNode[] = []
  let cursor = 0
  ranges.forEach((r, i) => {
    if (r.start > cursor) parts.push(<span key={`p${i}`}>{text.slice(cursor, r.start)}</span>)
    parts.push(
      <mark key={`m${i}`} className="bg-yellow-400/30 text-primary rounded-[2px]">
        {text.slice(r.start, r.end)}
      </mark>,
    )
    cursor = Math.max(cursor, r.end)
  })
  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>)
  return <>{parts}</>
}

/** Trim leading whitespace for display and shift ranges to match. */
function trimLeading(text: string, ranges: SearchMatchRange[]): { text: string; ranges: SearchMatchRange[] } {
  const leading = text.length - text.trimStart().length
  if (leading === 0) return { text, ranges }
  return {
    text: text.slice(leading),
    ranges: ranges.map((r) => ({ start: Math.max(0, r.start - leading), end: Math.max(0, r.end - leading) })),
  }
}

const baseName = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}
const dirName = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

type Row =
  | { kind: 'file'; file: SearchFileResult }
  | { kind: 'line'; file: SearchFileResult; lineIdx: number }

interface Props {
  /** Visible files (already filtered for dismissed files by the caller). */
  files: SearchFileResult[]
}

export const SearchResultsTree: React.FC<Props> = ({ files }) => {
  const collapsed = useSearchStore((s) => s.collapsed)
  const dismissedLines = useSearchStore((s) => s.dismissedLines)
  const toggleCollapse = useSearchStore((s) => s.toggleCollapse)
  const dismissFile = useSearchStore((s) => s.dismissFile)
  const dismissLine = useSearchStore((s) => s.dismissLine)

  const [selected, setSelected] = useState(0)

  // Build the flat list of visible rows (file headers + non-dismissed match lines).
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const file of files) {
      out.push({ kind: 'file', file })
      if (collapsed.has(file.path)) continue
      file.lines.forEach((ln, lineIdx) => {
        if (dismissedLines.has(lineKey(file.path, ln.line))) return
        out.push({ kind: 'line', file, lineIdx })
      })
    }
    return out
  }, [files, collapsed, dismissedLines])

  // Per-file count of matches still visible (excludes dismissed match lines).
  const visibleCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const file of files) {
      let c = 0
      for (const ln of file.lines) {
        if (dismissedLines.has(lineKey(file.path, ln.line))) continue
        c += ln.ranges.length
      }
      m.set(file.path, c)
    }
    return m
  }, [files, dismissedLines])

  // Keep the selected index within bounds as rows change.
  useEffect(() => {
    if (selected >= rows.length) setSelected(Math.max(0, rows.length - 1))
  }, [rows.length, selected])

  const openLine = (file: SearchFileResult, lineIdx: number): void => {
    const wsId = useAppStore.getState().selectedWorkspaceId
    if (!wsId) return
    const ln = file.lines[lineIdx]
    const column = (ln.ranges[0]?.start ?? 0) + 1
    const panelId = openFileAsPanel(wsId, file.path, undefined, { target: 'dock', zone: 'center' })
    setPendingReveal(panelId, { line: ln.line, column })
  }

  const activate = (row: Row): void => {
    if (row.kind === 'file') toggleCollapse(row.file.path)
    else openLine(row.file, row.lineIdx)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (rows.length === 0) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelected((i) => Math.min(rows.length - 1, i + 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelected((i) => Math.max(0, i - 1))
        break
      case 'ArrowRight': {
        const row = rows[selected]
        if (row?.kind === 'file' && collapsed.has(row.file.path)) {
          e.preventDefault()
          toggleCollapse(row.file.path)
        }
        break
      }
      case 'ArrowLeft': {
        const row = rows[selected]
        if (row?.kind === 'file' && !collapsed.has(row.file.path)) {
          e.preventDefault()
          toggleCollapse(row.file.path)
        }
        break
      }
      case 'Enter': {
        const row = rows[selected]
        if (row) {
          e.preventDefault()
          activate(row)
        }
        break
      }
    }
  }

  return (
    <div className="flex-1 overflow-y-auto outline-none py-1" tabIndex={0} onKeyDown={onKeyDown}>
      {rows.map((row, idx) => {
        const isSel = selected === idx
        if (row.kind === 'file') {
          const file = row.file
          const isCollapsed = collapsed.has(file.path)
          const dir = dirName(file.relativePath)
          const count = visibleCount.get(file.path) ?? file.matchCount
          return (
            <div
              key={`f:${file.path}`}
              className={`group flex items-center gap-1 pl-1 pr-2 py-0.5 text-xs cursor-pointer ${
                isSel ? 'bg-surface-5' : 'hover:bg-surface-5/50'
              }`}
              onClick={() => {
                setSelected(idx)
                toggleCollapse(file.path)
              }}
              title={file.relativePath}
            >
              <span className="flex-shrink-0 text-muted">
                {isCollapsed ? <CaretRight size={12} /> : <CaretDown size={12} />}
              </span>
              <FileIcon size={13} className="flex-shrink-0 text-muted" />
              <span className="text-primary truncate">{baseName(file.relativePath)}</span>
              {dir && <span className="text-muted text-[10px] truncate">{dir}</span>}
              <span className="ml-auto flex items-center gap-1">
                <span className="text-muted text-[10px] tabular-nums rounded-full bg-surface-5 px-1.5 leading-4 group-hover:hidden">
                  {count}
                </span>
                <button
                  className="hidden group-hover:flex text-muted hover:text-primary"
                  title="Dismiss file"
                  onClick={(e) => {
                    e.stopPropagation()
                    dismissFile(file.path)
                  }}
                >
                  <X size={12} />
                </button>
              </span>
            </div>
          )
        }

        const { file, lineIdx } = row
        const ln = file.lines[lineIdx]
        const isContext = ln.ranges.length === 0
        const display = trimLeading(ln.text, ln.ranges)
        return (
          <div
            key={`l:${file.path}:${ln.line}:${lineIdx}`}
            className={`group flex items-start gap-2 pr-2 py-0.5 text-xs cursor-pointer ${
              isSel ? 'bg-surface-5' : 'hover:bg-surface-5/50'
            }`}
            style={{ paddingLeft: 26 }}
            onClick={() => {
              setSelected(idx)
              if (!isContext) openLine(file, lineIdx)
            }}
          >
            <span className="flex-shrink-0 text-muted text-[10px] tabular-nums w-8 text-right select-none">
              {ln.line}
            </span>
            <span className={`truncate font-mono ${isContext ? 'text-muted/70' : 'text-secondary'}`}>
              <Highlighted text={display.text} ranges={display.ranges} />
            </span>
            {!isContext && (
              <button
                className="ml-auto hidden group-hover:flex flex-shrink-0 text-muted hover:text-primary"
                title="Dismiss match"
                onClick={(e) => {
                  e.stopPropagation()
                  dismissLine(file.path, ln.line)
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
