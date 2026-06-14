// =============================================================================
// SearchResultsTree — VS Code-style grouped results: collapsible files, each
// with highlighted match lines (and optional context). Supports keyboard
// navigation, open-at-line, and dismissing a match or a whole file.
// =============================================================================

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CaretRight, CaretDown, X } from '@phosphor-icons/react'
import type { SearchFileResult, SearchMatchRange } from '../../shared/types'
import { getFileIcon } from './FileTreeNode'
import { trimLeading } from './searchDisplay'
import { lookupNodeDecoration, type GitTree } from './gitStatusDecoration'
import { useSearchStore, lineKey } from '../stores/searchStore'
import { useAppStore } from '../stores/appStore'
import { openFileAsPanel } from '../lib/fs/fileRouting'
import { setPendingReveal } from '../lib/editor/editorReveal'
import { Tooltip } from '../ui/Tooltip'

// Uniform row height (px). Both the file-header and code-line rows are forced to
// this height so the windowed (virtualized) list can map scrollTop <-> row index
// with trivial arithmetic — no per-row measurement needed.
const ROW_H = 22
// Extra rows rendered above/below the viewport so fast scrolling never flashes
// blank before the next frame.
const OVERSCAN = 8

/** Render a line's text with its match ranges highlighted. */
const Highlighted: React.FC<{ text: string; ranges: SearchMatchRange[] }> = ({ text, ranges }) => {
  if (ranges.length === 0) return <>{text}</>
  const parts: React.ReactNode[] = []
  let cursor = 0
  ranges.forEach((r, i) => {
    if (r.start > cursor) parts.push(<span key={`p${i}`}>{text.slice(cursor, r.start)}</span>)
    parts.push(
      <mark key={`m${i}`} className="bg-surface-6 text-primary rounded-[2px]">
        {text.slice(r.start, r.end)}
      </mark>,
    )
    cursor = Math.max(cursor, r.end)
  })
  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>)
  return <>{parts}</>
}

const baseName = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}
const dirName = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}
const extOf = (name: string): string => {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i + 1)
}

/** Populate a drag with the same MIME types the Explorer uses, so canvas / dock
 *  / terminal / agent drop targets all accept it. For a line drag, also carry
 *  the line + column so canvas/dock drops can open at the match. */
function setFileDrag(e: React.DragEvent, path: string, line?: number, column?: number): void {
  e.dataTransfer.setData('application/cate-file', path)
  e.dataTransfer.setData('application/cate-files', JSON.stringify([path]))
  e.dataTransfer.setData('text/plain', path)
  if (line != null) {
    e.dataTransfer.setData('application/cate-file-line', JSON.stringify({ path, line, column: column ?? 1 }))
  }
  e.dataTransfer.effectAllowed = 'copy'
}

type Row =
  | { kind: 'file'; file: SearchFileResult }
  | { kind: 'line'; file: SearchFileResult; lineIdx: number }

interface Props {
  /** Visible files (already filtered for dismissed files by the caller). */
  files: SearchFileResult[]
  /** Git decorations for the repo, so file rows tint like the Explorer. */
  git?: GitTree
}

export const SearchResultsTree: React.FC<Props> = ({ files, git }) => {
  const collapsed = useSearchStore((s) => s.collapsed)
  const dismissedLines = useSearchStore((s) => s.dismissedLines)
  const toggleCollapse = useSearchStore((s) => s.toggleCollapse)
  const dismissFile = useSearchStore((s) => s.dismissFile)
  const dismissLine = useSearchStore((s) => s.dismissLine)

  const [selected, setSelected] = useState(0)

  // --- Virtualization state. Only the rows intersecting the viewport (plus a
  // small overscan) are mounted, so a query with thousands of matches stays
  // responsive. Default the viewport to a plausible height so the very first
  // render is already windowed (avoids momentarily committing every row).
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)
  const rafRef = useRef<number | null>(null)

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

  // Track the scroll viewport height (measured before paint so the first frame
  // is already windowed) and react to sidebar resizes.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = (): void => setViewportH(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Keep the keyboard-selected row visible: since off-screen rows aren't mounted,
  // we scroll by arithmetic instead of relying on the element's scrollIntoView.
  useEffect(() => {
    const el = containerRef.current
    if (!el || rows.length === 0) return
    const top = selected * ROW_H
    const bottom = top + ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
  }, [selected, rows.length])

  // rAF-throttle scroll updates to one windowing recompute per frame.
  const onScroll = (): void => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const el = containerRef.current
      if (el) setScrollTop(el.scrollTop)
    })
  }

  const total = rows.length
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const endIdx = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN)
  const visibleRows = rows.slice(startIdx, endIdx)

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
    <div
      ref={containerRef}
      // mr-1.5 insets the scroll box (and its right-edge scrollbar) 6px inboard
      // so the scrollbar no longer sits under the 6px sidebar resize handle and
      // they stop stealing each other's drags.
      className="flex-1 overflow-y-auto overflow-x-hidden outline-none mr-1.5"
      tabIndex={0}
      data-testid="search-results"
      data-keynav=""
      onScroll={onScroll}
      onKeyDown={onKeyDown}
    >
      {/* Tall spacer = full scroll height; the windowed slice below is absolutely
          positioned and translated down to the first visible row. */}
      <div style={{ height: total * ROW_H, position: 'relative', width: '100%' }}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${startIdx * ROW_H}px)`,
          }}
        >
          {visibleRows.map((row, i) => {
            const idx = startIdx + i
            const isSel = selected === idx
            if (row.kind === 'file') {
              const file = row.file
              const isCollapsed = collapsed.has(file.path)
              const dir = dirName(file.relativePath)
              const count = visibleCount.get(file.path) ?? file.matchCount
              const fileIcon = getFileIcon(extOf(file.relativePath), false, false)
              // Tint the file name by git status, exactly like the Explorer.
              const { decoration } = lookupNodeDecoration(git, file.path, false)
              const nameColor = decoration ? decoration.colorClass : 'text-primary'
              return (
                <div
                  key={`f:${file.path}`}
                  data-testid="search-file"
                  data-path={file.path}
                  data-selected={isSel}
                  className={`group flex items-center gap-1.5 pl-2 pr-2 text-xs cursor-pointer min-w-0 ${
                    isSel ? 'bg-surface-5 ring-1 ring-inset ring-blue-500/40' : 'hover:bg-surface-5'
                  }`}
                  style={{ height: ROW_H }}
                  onClick={() => {
                    setSelected(idx)
                    toggleCollapse(file.path)
                  }}
                  title={file.relativePath}
                  draggable
                  onDragStart={(e) => setFileDrag(e, file.path)}
                >
                  <span className="flex-shrink-0 text-muted">
                    {isCollapsed ? <CaretRight size={12} /> : <CaretDown size={12} />}
                  </span>
                  <span className="flex-shrink-0 flex items-center" style={{ color: fileIcon.color }}>
                    {fileIcon.icon}
                  </span>
                  <span
                    className={`truncate flex-shrink-0 max-w-[60%] ${nameColor} ${
                      decoration?.strike ? 'line-through' : ''
                    }`}
                  >
                    {baseName(file.relativePath)}
                  </span>
                  {dir && <span className="text-secondary text-[10px] truncate min-w-0">{dir}</span>}
                  <span className="ml-auto flex-shrink-0 flex items-center gap-1 pl-1">
                    <span className="text-secondary text-[10px] tabular-nums rounded-full bg-surface-6 px-1.5 leading-4 group-hover:hidden">
                      {count}
                    </span>
                    <Tooltip label="Dismiss file">
                      <button
                        className="hidden group-hover:flex text-muted hover:text-primary"
                        aria-label="Dismiss file"
                        onClick={(e) => {
                          e.stopPropagation()
                          dismissFile(file.path)
                        }}
                      >
                        <X size={12} />
                      </button>
                    </Tooltip>
                  </span>
                </div>
              )
            }

            const { file, lineIdx } = row
            const ln = file.lines[lineIdx]
            const isContext = ln.ranges.length === 0
            // Show the line with only leading whitespace trimmed; the row
            // truncates on the RIGHT (CSS), like VS Code — no left "…" clipping,
            // so leading context stays readable.
            const full = trimLeading(ln.text, ln.ranges)
            return (
              <div
                key={`l:${file.path}:${ln.line}:${lineIdx}`}
                data-testid="search-line"
                data-path={file.path}
                data-line={ln.line}
                data-selected={isSel}
                className={`group flex items-center gap-1.5 pr-1 text-xs cursor-pointer ${
                  isSel ? 'bg-surface-5 ring-1 ring-inset ring-blue-500/40' : 'hover:bg-surface-5'
                }`}
                style={{ paddingLeft: 20, height: ROW_H }}
                onClick={() => {
                  setSelected(idx)
                  if (!isContext) openLine(file, lineIdx)
                }}
                draggable
                onDragStart={(e) => setFileDrag(e, file.path, ln.line, (ln.ranges[0]?.start ?? 0) + 1)}
              >
                <span className="flex-shrink-0 text-muted text-[10px] tabular-nums text-left select-none min-w-[1.6rem]">
                  :{ln.line}
                </span>
                <span className={`truncate min-w-0 font-mono ${isContext ? 'text-muted' : 'text-primary'}`}>
                  <Highlighted text={full.text} ranges={full.ranges} />
                </span>
                {!isContext && (
                  <Tooltip label="Dismiss match">
                    <button
                      className="ml-auto hidden group-hover:flex flex-shrink-0 text-muted hover:text-primary"
                      aria-label="Dismiss match"
                      onClick={(e) => {
                        e.stopPropagation()
                        dismissLine(file.path, ln.line)
                      }}
                    >
                      <X size={12} />
                    </button>
                  </Tooltip>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
