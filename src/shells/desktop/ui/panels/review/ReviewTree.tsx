import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { ChevronDown, ChevronRight, Info } from 'lucide-react'
import { revealPanel } from '@client/host'
import { agentDisplayName } from '@services/agents/contract'
import type { RecordedFileSummary } from '@panels/review/contract'
import { PanelTitle, type usePanelTitles } from '../../client/host'
import { agentLogo } from '../../services/agents'
import { VirtualFileRows, type VirtualFileRowsHandle } from '../../workspace/files'
import { createDiffReader, RecordedFileBody } from './RecordedFileBody'
import { recordedEditKey, sourcePanelId, terminalFileKey, terminalGroupKey, terminalTitle, type ReviewSend, type ReviewTerminal, type useReviewView } from './useReview'

interface Props {
  workspaceId: string
  scrollRef: RefObject<HTMLDivElement>
  files: RecordedFileSummary[]
  source?: string
  terminals: ReadonlyMap<string, ReviewTerminal>
  titles: ReturnType<typeof usePanelTitles>
  view: ReturnType<typeof useReviewView>
  send: ReviewSend
}

interface FileHistory { edits: RecordedFileSummary[]; additions: number; deletions: number }
interface Group { id: string; sample: RecordedFileSummary; byPath: Map<string, FileHistory> }
type Row =
  | { kind: 'group'; key: string; group: Group; open: boolean }
  | { kind: 'file'; key: string; parent: string; history: FileHistory; open: boolean; edit?: RecordedFileSummary }
  | { kind: 'edit'; key: string; parent: string; file: RecordedFileSummary; open: boolean; index: number }

const VIRTUALIZE_AFTER = 60
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' })

/** Mount only rows near the viewport, including within long file histories. */
export function ReviewTree({ workspaceId, scrollRef, files, source, terminals, titles, view, send }: Props) {
  const { expanded, collapsedGroups } = view
  const grouped = useMemo(() => {
    const groups = new Map<string, Group>()
    for (const file of files) {
      const id = sourcePanelId(file, source)
      let group = groups.get(id)
      if (!group) {
        group = { id, sample: file, byPath: new Map() }
        groups.set(id, group)
      }
      const history = group.byPath.get(file.path) ?? { edits: [], additions: 0, deletions: 0 }
      history.edits.push(file)
      history.additions += file.additions
      history.deletions += file.deletions
      group.byPath.set(file.path, history)
    }
    const index = (id: string) => terminals.get(id)?.index ?? Infinity
    const result = [...groups.values()].sort((a, b) => index(a.id) - index(b.id) || a.id.localeCompare(b.id))
    for (const group of result) {
      group.byPath = new Map([...group.byPath].sort(([a], [b]) => a.localeCompare(b)))
      for (const { edits } of group.byPath.values()) {
        if (edits.length > 1) edits.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      }
    }
    return result
  }, [files, source, terminals])

  const rows = useMemo(() => {
    const rows: Row[] = []
    for (const group of grouped) {
      const groupKey = terminalGroupKey(group.id)
      if (!source) {
        const open = !collapsedGroups.has(groupKey)
        rows.push({ kind: 'group', key: groupKey, group, open })
        if (!open) continue
      }
      for (const [path, history] of group.byPath) {
        const key = terminalFileKey(group.id, path)
        const open = expanded.has(key)
        rows.push({ kind: 'file', key, parent: groupKey, history, open, edit: history.edits.length === 1 ? history.edits[0] : undefined })
        if (open && history.edits.length > 1) history.edits.forEach((file, index) => {
          const editKey = recordedEditKey(file)
          rows.push({ kind: 'edit', key: editKey, parent: key, file, open: expanded.has(editKey), index })
        })
      }
    }
    return rows
  }, [grouped, source, expanded, collapsedGroups])
  const keys = useMemo(() => rows.map((row) => row.key), [rows])
  const variableHeight = useMemo(() => new Set(rows.flatMap((row) =>
    (row.kind === 'edit' || (row.kind === 'file' && row.edit)) && row.open ? [row.key] : [])), [rows])
  const virtual = useRef<VirtualFileRowsHandle>(null)
  const [active, setActive] = useState<string>()
  const [selectionRows, setSelectionRows] = useState<string[]>([])
  const pinned = useMemo(() => new Set(active ? [active, ...selectionRows] : selectionRows), [active, selectionRows])
  const target = useRef<string>()
  const lastReveal = useRef(0)
  const readPage = useMemo(() => createDiffReader(send), [send])
  const findButton = useCallback((key: string) => Array.from(scrollRef.current?.querySelectorAll<HTMLButtonElement>('[data-review-toggle]') ?? [])
    .find((button) => button.dataset.reviewToggle === key), [scrollRef])

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || files.length <= VIRTUALIZE_AFTER) return
    const update = () => {
      const selection = window.getSelection()
      const selected = selection && !selection.isCollapsed ? [selection.anchorNode, selection.focusNode] : []
      const keys = new Set<string>()
      for (const node of selected) {
        if (!node || !scroll.contains(node)) continue
        const element = node instanceof Element ? node : node.parentElement
        const key = element?.closest<HTMLElement>('[data-review-outline-row]')?.dataset.reviewOutlineRow
        if (key !== undefined) keys.add(key)
      }
      const next = [...keys]
      setSelectionRows((previous) => previous.length === next.length && previous.every((key, i) => key === next[i]) ? previous : next)
    }
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [scrollRef, files.length])

  useLayoutEffect(() => {
    if (!target.current) return
    const button = findButton(target.current)
    if (button) {
      target.current = undefined
      button.focus({ preventScroll: true })
    }
  }, [active, rows, findButton])
  useLayoutEffect(() => {
    if (!view.focusedFile || view.revealSeq === lastReveal.current) return
    const row = rows.find((row) => row.kind === 'file' && row.history.edits[0].path === view.focusedFile && row.open)
    if (!row) return
    lastReveal.current = view.revealSeq
    if (virtual.current) virtual.current.reveal(row.key, 'start')
    else findButton(row.key)?.scrollIntoView?.({ block: 'start' })
  }, [rows, view.focusedFile, view.revealSeq, findButton])

  const toggle = useCallback((row: Row) => {
    if (row.kind === 'group') view.toggleGroup(row.key)
    else view.toggleExpanded(row.key)
  }, [view])
  const navigate = useCallback((event: KeyboardEvent<HTMLButtonElement>, row: Row, index: number) => {
    const key = event.key
    let next: Row | undefined
    if (key === 'ArrowDown') next = rows[index + 1]
    else if (key === 'ArrowUp') next = rows[index - 1]
    else if (key === 'Home') next = rows[0]
    else if (key === 'End') next = rows[rows.length - 1]
    else if (key === 'ArrowRight') {
      if (!row.open) toggle(row)
      const child = rows[index + 1]
      if (row.open && child && 'parent' in child && child.parent === row.key) next = child
    } else if (key === 'ArrowLeft') {
      if (row.open) toggle(row)
      else if ('parent' in row) next = rows.find((item) => item.key === row.parent)
    } else return
    event.preventDefault()
    event.stopPropagation()
    if (!next || next.key === row.key) return
    target.current = next.key
    if (virtual.current) virtual.current.reveal(next.key)
    else findButton(next.key)?.scrollIntoView?.({ block: 'nearest' })
    setActive(next.key)
  }, [rows, toggle, findButton])

  const renderRow = useCallback((index: number) => {
    const row = rows[index]
    const caret = row.open ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />
    const buttonProps = {
      type: 'button' as const,
      'aria-expanded': row.open,
      'data-review-toggle': row.key,
      onClick: () => toggle(row),
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => navigate(event, row, index),
    }
    const action = row.open ? 'Collapse' : 'Expand'
    if (row.kind === 'group') {
      const { id, sample, byPath } = row.group
      const panel = terminals.get(id)?.panel
      const title = terminalTitle(sample, id, terminals)
      return <section data-review-group={row.key} onFocus={() => setActive(row.key)}
        className="flex h-8 min-w-0 items-center gap-1 border-b border-subtle bg-surface-1 pl-1 pr-3 text-xs text-secondary">
        <button {...buttonProps} aria-label={`${action} ${title}`}
          className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-primary">
          {caret}
        </button>
        <span data-review-group-title className="flex min-w-0 flex-1 items-center">
          {panel ? <button type="button" aria-label={`Go to ${title}`} title={`Go to ${title}`}
            onClick={() => void revealPanel(workspaceId, panel.id)} className="flex h-7 min-w-0 items-center rounded px-1 text-left hover:bg-hover hover:text-primary">
            <PanelTitle {...titles.props(panel)} iconSize={14} />
          </button> : <PanelTitle record={{ type: 'terminal', title }} iconSize={14} className="px-1"
            decoration={id ? { logo: agentLogo(sample.agentId), logoAlt: agentDisplayName(sample.agentId) } : undefined} />}
        </span>
        <span className="shrink-0 text-[10px] text-muted">{byPath.size} {byPath.size === 1 ? 'file' : 'files'}</span>
      </section>
    }
    const file = row.kind === 'edit' ? row.file : row.history.edits[0]
    const diff = row.kind === 'edit' ? row.file : row.edit
    const multi = row.kind === 'file' && !diff
    const date = row.kind === 'edit' && file.createdAt ? Date.parse(file.createdAt) : NaN
    const historyLabel = file.commit ? `${file.commit.hash.slice(0, 7)} · ${file.commit.message}` : file.uncommitted ? 'Uncommitted edit' : 'Recorded edit'
    const label = row.kind === 'edit' ? historyLabel
      : `${!multi && file.oldPath ? file.oldPath + ' → ' : ''}${file.path}`
    return <section data-review-outline-row={row.key} onFocus={() => setActive(row.key)}
      data-review-file={row.kind === 'file' ? encodeURIComponent(file.path) : undefined} data-review-edit={row.kind === 'edit' ? file.recordId : undefined} className="min-w-0">
      <div className={`flex h-8 min-w-0 items-center gap-2 border-b border-subtle pr-3 ${row.open && diff ? 'sticky top-0 z-10 bg-surface-2' : 'bg-surface-0'} ${row.kind === 'edit' ? source ? 'pl-7' : 'pl-10' : source ? 'pl-3' : 'pl-6'}`}>
        <button {...buttonProps} aria-label={`${action} ${row.kind === 'edit' ? `edit ${row.index + 1} for ` : ''}${file.path}`}
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left hover:bg-hover">
          {caret}
          <span className={`min-w-0 flex-1 truncate text-[11px] ${row.kind === 'file' ? 'font-mono' : ''}`} title={label}>{label}</span>
          {row.kind === 'file' && diff && (file.commit || file.uncommitted) && <span className="max-w-32 truncate text-[10px] text-muted" title={historyLabel}>
            {file.commit ? file.commit.hash.slice(0, 7) : 'Uncommitted'}
          </span>}
          {diff?.prNumber && <span className="shrink-0 text-[10px] text-muted" title="Pull request associated at capture">PR #{diff.prNumber}</span>}
          {Number.isFinite(date) && <span className="shrink-0 text-[10px] text-muted">{dateFormat.format(date)}</span>}
          {multi && <span className="shrink-0 text-[10px] text-muted">{row.history.edits.length} edits</span>}
        </button>
        <span className="text-[10px] tabular-nums text-diff-add">+{row.kind === 'file' ? row.history.additions : file.additions}</span>
        <span className="text-[10px] tabular-nums text-diff-del">−{row.kind === 'file' ? row.history.deletions : file.deletions}</span>
        {diff?.coverage === 'fragment' && <span title="Reported edit fragment; full-file context and line numbers are unavailable." className="text-muted"><Info size={12} /></span>}
      </div>
      {row.open && diff && <RecordedFileBody key={`${recordedEditKey(diff)}:${view.pageFor(recordedEditKey(diff))}`}
        readPage={readPage} file={diff} display={view.display} page={view.pageFor(recordedEditKey(diff))}
        setPage={(page) => view.setPage(recordedEditKey(diff), page)} />}
    </section>
  }, [rows, source, terminals, titles, workspaceId, readPage, view, toggle, navigate])

  return files.length > VIRTUALIZE_AFTER
    ? <VirtualFileRows ref={virtual} paths={keys} scrollRef={scrollRef} pinned={pinned} renderRow={renderRow} variableHeight={variableHeight} />
    : <>{rows.map((row, index) => <div key={row.key}>{renderRow(index)}</div>)}</>
}
