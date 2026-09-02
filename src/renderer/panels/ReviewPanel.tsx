import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowClockwise,
  CaretDown,
  CaretDoubleDown,
  CaretDoubleUp,
  CaretRight,
  Check,
  ClipboardText,
  Code,
  DotsThree,
  File,
  FileMagnifyingGlass,
  GitDiff,
  GitPullRequest,
  ImageSquare,
  Minus,
  NotePencil,
  Plus,
  PushPin,
  Rows,
  SplitHorizontal,
  Trash,
} from '@phosphor-icons/react'
import type {
  GitChangedFile,
  GitComparisonResult,
  GitComparisonSpec,
  GitDiffHunk,
  GitDiffLine,
  GitFileDiff,
  GitReviewNote,
  ReviewPanelState,
} from '../../shared/types'
import type { PanelProps } from './types'
import { useAppStore } from '../stores/appStore'
import { Tooltip } from '../ui/Tooltip'
import { errorMessage } from '../lib/errorMessage'
import { formatLocator, parseLocator } from '../../shared/runtimeLocator'
import { gitStatusStore, useGitStatusSnapshot } from '../stores/gitStatusStore'

const MODES: Array<{ value: GitComparisonSpec['kind']; label: string }> = [
  { value: 'uncommitted', label: 'Uncommitted' },
  { value: 'unstaged', label: 'Unstaged' },
  { value: 'staged', label: 'Staged' },
  { value: 'commit', label: 'Commit' },
  { value: 'branch', label: 'Branch' },
]

interface BranchInfo {
  name: string
  current: boolean
  isRemote: boolean
}

interface CommitInfo {
  hash: string
  message: string
  author_name: string
  date: string
}

function defaultReviewState(repoPath: string): ReviewPanelState {
  return {
    repoPath,
    spec: { kind: 'uncommitted' },
    display: { split: false, wordDiff: true, wrap: false, fullFile: false, advancedPreview: true },
    collapsedFiles: [],
    notes: [],
  }
}

function statusLabel(file: GitChangedFile): string {
  switch (file.status) {
    case 'added': return 'A'
    case 'deleted': return 'D'
    case 'renamed': return 'R'
    case 'copied': return 'C'
    case 'type-changed': return 'T'
    case 'unmerged': return 'U'
    default: return 'M'
  }
}

function statusClass(file: GitChangedFile): string {
  if (file.status === 'added') return 'text-diff-add'
  if (file.status === 'deleted') return 'text-diff-del'
  if (file.status === 'unmerged') return 'text-orange-400'
  return 'text-yellow-400'
}

function absoluteFilePath(rootPath: string, relativePath: string): string {
  const { runtimeId, path } = parseLocator(rootPath)
  return formatLocator({ runtimeId, path: `${path.replace(/\/+$/, '')}/${relativePath}` })
}

function imageMime(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'svg') return 'image/svg+xml'
  if (ext === 'bmp') return 'image/bmp'
  return null
}

function wordHighlight(text: string, other: string | undefined, enabled: boolean): React.ReactNode {
  if (!enabled || other == null || text === other) return text || ' '
  let start = 0
  while (start < text.length && start < other.length && text[start] === other[start]) start++
  let end = 0
  while (
    end < text.length - start
    && end < other.length - start
    && text[text.length - 1 - end] === other[other.length - 1 - end]
  ) end++
  const middleEnd = end ? text.length - end : text.length
  return (
    <>
      {text.slice(0, start)}
      <span className="bg-current/15 rounded-sm">{text.slice(start, middleEnd) || ' '}</span>
      {end ? text.slice(text.length - end) : ''}
    </>
  )
}

function counterpart(lines: GitDiffLine[], index: number): string | undefined {
  const line = lines[index]
  if (line.kind === 'delete') {
    let start = index
    while (start > 0 && lines[start - 1].kind === 'delete') start--
    let addStart = index + 1
    while (addStart < lines.length && lines[addStart].kind === 'delete') addStart++
    if (lines[addStart]?.kind !== 'add') return undefined
    return lines[addStart + (index - start)]?.kind === 'add' ? lines[addStart + (index - start)].text : undefined
  }
  if (line.kind === 'add') {
    let addStart = index
    while (addStart > 0 && lines[addStart - 1].kind === 'add') addStart--
    const deleteEnd = addStart - 1
    if (lines[deleteEnd]?.kind !== 'delete') return undefined
    let deleteStart = deleteEnd
    while (deleteStart > 0 && lines[deleteStart - 1].kind === 'delete') deleteStart--
    const candidate = lines[deleteStart + (index - addStart)]
    return candidate?.kind === 'delete' ? candidate.text : undefined
  }
  return undefined
}

function notesMarkdown(notes: GitReviewNote[]): string {
  const grouped = new Map<string, GitReviewNote[]>()
  for (const note of notes) grouped.set(note.path, [...(grouped.get(note.path) ?? []), note])
  const output = ['# Review notes', '']
  for (const [filePath, fileNotes] of grouped) {
    output.push(`## ${filePath}`, '')
    for (const note of fileNotes) {
      const location = note.side === 'file' ? 'File' : `${note.side} line ${note.line ?? '?'}`
      output.push(`- **${location}${note.outdated ? ' (outdated)' : ''}:** ${note.body}`)
    }
    output.push('')
  }
  return output.join('\n')
}

function contextHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const ToolbarButton: React.FC<{
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}> = ({ label, active, disabled, onClick, children }) => (
  <Tooltip label={label} placement="bottom">
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors disabled:opacity-30 ${active ? 'bg-hover-strong text-primary' : 'text-muted hover:text-primary hover:bg-hover'}`}
    >
      {children}
    </button>
  </Tooltip>
)

const ReviewMenuButton: React.FC<{
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}> = ({ label, active, disabled, onClick, children }) => (
  <button
    type="button"
    role="menuitem"
    disabled={disabled}
    onClick={onClick}
    className="w-full h-8 px-2.5 rounded-md flex items-center gap-2 text-[11px] text-secondary hover:text-primary hover:bg-hover disabled:opacity-30 disabled:pointer-events-none"
  >
    <span className="w-4 flex items-center justify-center text-muted">{children}</span>
    <span className="flex-1 text-left">{label}</span>
    <span className="w-4 flex items-center justify-center">{active && <Check size={12} />}</span>
  </button>
)

function SearchableRefInput({
  id,
  value,
  options,
  onCommit,
  className,
  ariaLabel,
}: {
  id: string
  value: string
  options: Array<{ value: string; label?: string }>
  onCommit: (value: string) => void
  className: string
  ariaLabel: string
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const next = draft.trim()
    if (next && next !== value) onCommit(next)
  }
  return (
    <>
      <input
        aria-label={ariaLabel}
        list={id}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit()
            event.currentTarget.blur()
          }
        }}
        className={className}
      />
      <datalist id={id}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </datalist>
    </>
  )
}

function LazyDiffBody({
  diff,
  load,
  allowLarge,
  split,
  wordDiff,
  wrap,
  notes,
  addNote,
}: {
  diff?: GitFileDiff
  load: () => void
  allowLarge: () => void
  split: boolean
  wordDiff: boolean
  wrap: boolean
  notes: GitReviewNote[]
  addNote: (side: 'old' | 'new', line: number, context: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (diff) return
    if (typeof IntersectionObserver === 'undefined') { load(); return }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        load()
        observer.disconnect()
      }
    }, { rootMargin: '600px' })
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [diff, load])

  if (!diff) return <div ref={ref} className="h-20 flex items-center justify-center text-[11px] text-muted">Loading diff...</div>
  if (diff.binary) return <div ref={ref} className="px-4 py-6 text-center text-[11px] text-muted">Binary file changed</div>
  if (diff.tooLarge) {
    return (
      <div ref={ref} className="px-4 py-6 flex flex-col items-center gap-2 text-[11px] text-muted">
        <span>Diff is large ({Math.ceil(diff.byteLength / 1024).toLocaleString()} KiB)</span>
        <button className="px-2.5 py-1 rounded-lg bg-surface-2 hover:bg-hover text-primary" onClick={allowLarge}>Load full diff</button>
      </div>
    )
  }
  if (diff.hunks.length === 0) return <div ref={ref} className="px-4 py-5 text-center text-[11px] text-muted">No textual changes</div>

  return (
    <div ref={ref} className={`font-mono text-[11px] leading-[1.45] ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}>
      {diff.hunks.map((hunk, hunkIndex) => (
        <HunkView
          key={`${hunk.header}-${hunkIndex}`}
          hunk={hunk}
          split={split}
          wordDiff={wordDiff}
          wrap={wrap}
          notes={notes}
          addNote={addNote}
        />
      ))}
    </div>
  )
}

function NoteRows({ notes }: { notes: GitReviewNote[] }) {
  if (notes.length === 0) return null
  return (
    <div className="px-3 py-1.5 bg-blue-500/[0.08] border-y border-blue-500/15 font-sans whitespace-normal">
      {notes.map((note) => (
        <div key={note.id} className={`text-[11px] ${note.outdated ? 'text-muted line-through' : 'text-primary/80'}`}>
          <NotePencil size={11} className="inline mr-1" />{note.body}
        </div>
      ))}
    </div>
  )
}

function UnifiedLine({
  line,
  other,
  wordDiff,
  notes,
  addNote,
}: {
  line: GitDiffLine
  other?: string
  wordDiff: boolean
  notes: GitReviewNote[]
  addNote: (side: 'old' | 'new', line: number, context: string) => void
}) {
  const side = line.kind === 'delete' ? 'old' : 'new'
  const lineNumber = side === 'old' ? line.oldLine : line.newLine
  const background = line.kind === 'add' ? 'bg-diff-add' : line.kind === 'delete' ? 'bg-diff-del' : ''
  const color = line.kind === 'add' ? 'text-diff-add' : line.kind === 'delete' ? 'text-diff-del' : 'text-primary/75'
  const lineNotes = lineNumber == null ? [] : notes.filter((note) => note.side === side && note.line === lineNumber)
  return (
    <>
      <div className={`group flex min-w-0 w-full ${background}`}>
        <button
          className="w-10 shrink-0 text-right pr-2 text-muted/45 select-none hover:text-primary"
          disabled={lineNumber == null}
          onClick={() => lineNumber != null && addNote(side, lineNumber, line.text)}
        >
          {line.oldLine ?? ''}
        </button>
        <button
          className="w-10 shrink-0 text-right pr-2 text-muted/45 select-none hover:text-primary"
          disabled={lineNumber == null}
          onClick={() => lineNumber != null && addNote(side, lineNumber, line.text)}
        >
          {line.newLine ?? ''}
        </button>
        <span className={`w-4 shrink-0 select-none ${color}`}>{line.kind === 'add' ? '+' : line.kind === 'delete' ? '-' : ' '}</span>
        <span className={`flex-1 min-w-0 pr-4 ${color}`}>{wordHighlight(line.text, other, wordDiff && (line.kind === 'add' || line.kind === 'delete'))}</span>
      </div>
      <NoteRows notes={lineNotes} />
    </>
  )
}

interface SplitRow {
  left?: GitDiffLine
  right?: GitDiffLine
}

function splitRows(lines: GitDiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (line.kind === 'delete') {
      const deletions: GitDiffLine[] = []
      const additions: GitDiffLine[] = []
      while (lines[i]?.kind === 'delete') deletions.push(lines[i++])
      while (lines[i]?.kind === 'add') additions.push(lines[i++])
      for (let n = 0; n < Math.max(deletions.length, additions.length); n++) rows.push({ left: deletions[n], right: additions[n] })
    } else if (line.kind === 'add') {
      rows.push({ right: line })
      i++
    } else {
      rows.push({ left: line, right: line })
      i++
    }
  }
  return rows
}

function SplitCell({
  line,
  side,
  other,
  wordDiff,
  addNote,
}: {
  line?: GitDiffLine
  side: 'old' | 'new'
  other?: string
  wordDiff: boolean
  addNote: (side: 'old' | 'new', line: number, context: string) => void
}) {
  const number = side === 'old' ? line?.oldLine : line?.newLine
  const kind = line?.kind
  return (
    <div className={`flex min-w-0 ${kind === 'delete' ? 'bg-diff-del' : kind === 'add' ? 'bg-diff-add' : ''}`}>
      <button className="w-10 shrink-0 text-right pr-2 text-muted/45" disabled={number == null} onClick={() => number != null && line && addNote(side, number, line.text)}>{number ?? ''}</button>
      <span className={`w-4 shrink-0 ${kind === 'delete' ? 'text-diff-del' : kind === 'add' ? 'text-diff-add' : ''}`}>{kind === 'delete' ? '-' : kind === 'add' ? '+' : ' '}</span>
      <span className="flex-1 overflow-hidden pr-2">{line ? wordHighlight(line.text, other, wordDiff) : ' '}</span>
    </div>
  )
}

function HunkView({ hunk, split, wordDiff, wrap, notes, addNote }: {
  hunk: GitDiffHunk
  split: boolean
  wordDiff: boolean
  wrap: boolean
  notes: GitReviewNote[]
  addNote: (side: 'old' | 'new', line: number, context: string) => void
}) {
  const metadataOnly = hunk.lines.every((line) => line.kind === 'meta')
  return (
    <div>
      <div className="px-3 py-1 text-blue-400/70 bg-blue-500/[0.07] border-y border-blue-500/10 select-text">{hunk.header}</div>
      {metadataOnly ? hunk.lines.map((line, index) => (
        <div key={index} className="px-3 py-0.5 text-muted">{line.text}</div>
      )) : split ? splitRows(hunk.lines).map((row, index) => (
        <React.Fragment key={index}>
          <div className={`grid grid-cols-2 divide-x divide-subtle text-primary/75 ${wrap ? 'min-w-0' : 'min-w-[720px]'}`}>
            <SplitCell line={row.left} side="old" other={row.right?.text} wordDiff={wordDiff} addNote={addNote} />
            <SplitCell line={row.right} side="new" other={row.left?.text} wordDiff={wordDiff} addNote={addNote} />
          </div>
          <NoteRows notes={notes.filter((note) =>
            (note.side === 'old' && note.line === row.left?.oldLine)
            || (note.side === 'new' && note.line === row.right?.newLine))}
          />
        </React.Fragment>
      )) : hunk.lines.map((line, index) => (
        <UnifiedLine key={index} line={line} other={counterpart(hunk.lines, index)} wordDiff={wordDiff} notes={notes} addNote={addNote} />
      ))}
    </div>
  )
}

function ImageComparisonPreview({ repoPath, spec, file, workspaceId }: { repoPath: string; spec: GitComparisonSpec; file: GitChangedFile; workspaceId: string }) {
  const [urls, setUrls] = useState<{ old: string | null; new: string | null }>({ old: null, new: null })
  const mime = imageMime(file.path)
  useEffect(() => {
    if (!mime) return
    let cancelled = false
    const createdUrls: string[] = []
    const blobUrl = (base64: string | null | undefined): string | null => {
      if (!base64) return null
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
      createdUrls.push(url)
      return url
    }
    Promise.all([
      window.electronAPI.gitFileContent(repoPath, spec, file.oldPath ?? file.path, 'old', workspaceId),
      window.electronAPI.gitFileContent(repoPath, spec, file.path, 'new', workspaceId),
    ]).then(([oldContent, newContent]) => {
      if (cancelled) return
      setUrls({
        old: blobUrl(oldContent.base64),
        new: blobUrl(newContent.base64),
      })
    }).catch(() => setUrls({ old: null, new: null }))
    return () => {
      cancelled = true
      for (const url of createdUrls) URL.revokeObjectURL(url)
    }
  }, [repoPath, spec, file, workspaceId, mime])
  if (!mime) return null
  return (
    <div className="grid grid-cols-2 divide-x divide-subtle bg-[linear-gradient(45deg,var(--surface-2)_25%,transparent_25%),linear-gradient(-45deg,var(--surface-2)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--surface-2)_75%),linear-gradient(-45deg,transparent_75%,var(--surface-2)_75%)] bg-[length:18px_18px]">
      <div className="p-4 min-h-28 relative"><span className="absolute top-1 left-2 text-[10px] text-muted bg-surface-0/80 px-1 rounded">Before</span>{urls.old ? <img src={urls.old} className="max-h-[420px] max-w-full mx-auto object-contain" alt={`Before ${file.path}`} /> : <div className="h-full flex items-center justify-center text-muted text-[11px]">Not present</div>}</div>
      <div className="p-4 min-h-28 relative"><span className="absolute top-1 left-2 text-[10px] text-muted bg-surface-0/80 px-1 rounded">After</span>{urls.new ? <img src={urls.new} className="max-h-[420px] max-w-full mx-auto object-contain" alt={`After ${file.path}`} /> : <div className="h-full flex items-center justify-center text-muted text-[11px]">Not present</div>}</div>
    </div>
  )
}

export default function ReviewPanel({ panelId, workspaceId }: PanelProps) {
  const workspace = useAppStore((state) => state.workspaces.find((item) => item.id === workspaceId))
  const stored = workspace?.panels[panelId]?.reviewState
  const reviewState = stored ?? defaultReviewState(workspace?.rootPath ?? '')
  const gitSnapshot = useGitStatusSnapshot(reviewState.repoPath)
  const stateRef = useRef(reviewState)
  stateRef.current = reviewState
  const [comparison, setComparison] = useState<GitComparisonResult | null>(null)
  const [diffs, setDiffs] = useState<Record<string, GitFileDiff>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [trackingBranch, setTrackingBranch] = useState<string | null>(null)
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [commitMessage, setCommitMessage] = useState('')
  const [includeUnstaged, setIncludeUnstaged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const activeLoads = useRef(0)
  const loadQueue = useRef<Array<() => void>>([])

  const persist = useCallback((next: ReviewPanelState) => {
    stateRef.current = next
    useAppStore.getState().setPanelReviewState(workspaceId, panelId, next)
  }, [workspaceId, panelId])

  useEffect(() => {
    if (!stored && workspace?.rootPath) persist(defaultReviewState(workspace.rootPath))
  }, [stored, workspace?.rootPath, persist])

  useEffect(() => {
    if (!moreOpen) return
    const close = (event: PointerEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) setMoreOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [moreOpen])

  const update = useCallback((patch: Partial<ReviewPanelState>) => {
    persist({ ...stateRef.current, ...patch })
  }, [persist])

  const updateDisplay = useCallback((patch: Partial<ReviewPanelState['display']>) => {
    persist({ ...stateRef.current, display: { ...stateRef.current.display, ...patch } })
  }, [persist])

  const refresh = useCallback(async () => {
    const current = ++generation.current
    const state = stateRef.current
    if (!state.repoPath) return
    setLoading(true)
    setError(null)
    setDiffs({})
    try {
      const result = await window.electronAPI.gitCompare(state.repoPath, state.spec, workspaceId)
      if (generation.current !== current) return
      setComparison(result)
      const paths = new Set(result.files.map((file) => file.path))
      const notes = (state.notes ?? []).map((note) => ({ ...note, outdated: !paths.has(note.path) }))
      if (notes.some((note, index) => note.outdated !== state.notes?.[index]?.outdated)) {
        persist({ ...state, notes })
      }
      requestAnimationFrame(() => {
        if (!state.focusedFile) return
        document.querySelector(`[data-review-file="${encodeURIComponent(state.focusedFile)}"]`)?.scrollIntoView({ block: 'start' })
      })
    } catch (cause) {
      if (generation.current === current) setError(errorMessage(cause, 'Could not load comparison'))
    } finally {
      if (generation.current === current) setLoading(false)
    }
  }, [workspaceId, persist])

  useEffect(() => { void refresh() }, [reviewState.spec, reviewState.repoPath, refresh])
  useEffect(() => {
    if (gitSnapshot.revision > 0) void refresh()
  }, [gitSnapshot.revision, refresh])
  useEffect(() => {
    if (!reviewState.focusedFile || !comparison) return
    requestAnimationFrame(() => {
      document.querySelector(`[data-review-file="${encodeURIComponent(reviewState.focusedFile ?? '')}"]`)?.scrollIntoView({ block: 'start' })
    })
  }, [reviewState.focusedFile, comparison])
  useEffect(() => {
    if (!reviewState.repoPath) return
    Promise.all([
      window.electronAPI.gitBranchList(reviewState.repoPath, workspaceId),
      window.electronAPI.gitLog(reviewState.repoPath, 100, workspaceId),
      window.electronAPI.gitStatus(reviewState.repoPath, workspaceId),
    ]).then(([branchResult, logResult, statusResult]) => {
      setBranches(branchResult.branches)
      setCommits(logResult)
      setTrackingBranch(statusResult.tracking)
    }).catch(() => {})
  }, [reviewState.repoPath, workspaceId, gitSnapshot.revision])

  const pumpLoads = useCallback(() => {
    while (activeLoads.current < 4 && loadQueue.current.length > 0) {
      activeLoads.current++
      loadQueue.current.shift()?.()
    }
  }, [])

  const limited = useCallback(<T,>(factory: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    loadQueue.current.push(() => {
      factory().then(resolve, reject).finally(() => {
        activeLoads.current--
        pumpLoads()
      })
    })
    pumpLoads()
  }), [pumpLoads])

  const reanchorNotes = useCallback((filePath: string, diff: GitFileDiff) => {
    const state = stateRef.current
    let changed = false
    const notes = (state.notes ?? []).map((note) => {
      if (note.path !== filePath || note.side === 'file') return note
      const candidates = diff.hunks.flatMap((hunk) => hunk.lines).filter((line) =>
        note.side === 'old' ? line.oldLine != null : line.newLine != null)
      const exact = candidates.find((line) =>
        (note.side === 'old' ? line.oldLine : line.newLine) === note.line
        && (note.contextHash ? contextHash(line.text) === note.contextHash : line.text === note.context))
      const relocated = exact ?? candidates.find((line) =>
        note.contextHash ? contextHash(line.text) === note.contextHash : line.text === note.context)
      const nextLine = relocated ? (note.side === 'old' ? relocated.oldLine : relocated.newLine) : note.line
      const outdated = !relocated
      if (nextLine !== note.line || outdated !== !!note.outdated) changed = true
      return { ...note, line: nextLine, outdated }
    })
    if (changed) persist({ ...state, notes })
  }, [persist])

  const requestDiff = useCallback((file: GitChangedFile, allowLarge = false) => {
    if (!allowLarge && diffs[file.path]) return
    const state = stateRef.current
    const requestGeneration = generation.current
    void limited(() => window.electronAPI.gitFileDiff(
      state.repoPath,
      state.spec,
      file.path,
      { contextLines: state.display.fullFile ? 999_999 : 3, allowLarge },
      workspaceId,
    )).then((diff) => {
      if (requestGeneration !== generation.current) return
      setDiffs((current) => ({ ...current, [file.path]: diff }))
      reanchorNotes(file.path, diff)
    }).catch((cause) => {
      if (requestGeneration === generation.current) setError(errorMessage(cause, `Could not load ${file.path}`))
    })
  }, [diffs, limited, workspaceId, reanchorNotes])

  const setMode = useCallback((kind: GitComparisonSpec['kind']) => {
    const ignoreWhitespace = stateRef.current.spec.ignoreWhitespace
    if (kind === 'commit') {
      const commit = commits[0]?.hash
      if (!commit) return
      update({ spec: { kind, commit, ignoreWhitespace } })
      return
    }
    if (kind === 'branch') {
      const current = branches.find((branch) => branch.current)?.name ?? branches.find((branch) => !branch.isRemote)?.name
      const upstream = trackingBranch
        ? branches.find((branch) => branch.name === trackingBranch || branch.name === `remotes/${trackingBranch}`)?.name
        : undefined
      const base = upstream
        ?? branches.find((branch) => branch.name === 'main')?.name
        ?? branches.find((branch) => branch.name === 'master')?.name
        ?? branches.find((branch) => branch.name !== current)?.name
      if (!current || !base) return
      update({ spec: { kind, base, target: current, ignoreWhitespace } })
      return
    }
    update({ spec: { kind, ignoreWhitespace } })
  }, [branches, commits, trackingBranch, update])

  const toggleWhitespace = useCallback(() => {
    const spec = stateRef.current.spec
    update({ spec: { ...spec, ignoreWhitespace: !spec.ignoreWhitespace } as GitComparisonSpec })
  }, [update])

  const addNote = useCallback((filePath: string, side: 'old' | 'new' | 'file', line: number | null, context: string) => {
    const body = window.prompt(side === 'file' ? `Review note for ${filePath}` : `Review note for ${filePath}:${line}`)?.trim()
    if (!body) return
    const state = stateRef.current
    const note: GitReviewNote = {
      id: crypto.randomUUID(),
      path: filePath,
      side,
      line,
      body,
      context,
      contextHash: contextHash(context),
      resolvedBase: comparison?.resolvedBase ?? null,
      resolvedTarget: comparison?.resolvedTarget ?? null,
      createdAt: new Date().toISOString(),
    }
    persist({ ...state, notes: [...(state.notes ?? []), note] })
  }, [comparison, persist])

  const mutate = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      gitStatusStore.refresh(stateRef.current.repoPath)
      await refresh()
    }
    catch (cause) { setError(errorMessage(cause, 'Git action failed')) }
    finally { setBusy(false) }
  }, [refresh])

  const stage = (file: GitChangedFile) => mutate(() => window.electronAPI.gitStage(reviewState.repoPath, file.path, workspaceId))
  const unstage = (file: GitChangedFile) => mutate(() => window.electronAPI.gitUnstage(reviewState.repoPath, file.path, workspaceId))
  const discard = (file: GitChangedFile) => {
    if (file.untracked) {
      const local = parseLocator(reviewState.repoPath).runtimeId === 'local'
      const prompt = local
        ? `Move untracked file "${file.path}" to Trash?`
        : `Permanently delete untracked file "${file.path}" from the remote host? This cannot be undone.`
      if (!window.confirm(prompt)) return
      void mutate(() => window.electronAPI.fsTrashOrDelete(
        absoluteFilePath(reviewState.repoPath, file.path),
        workspaceId,
      ))
      return
    }
    if (!window.confirm(`Discard working changes in "${file.path}"? Staged changes will be preserved.`)) return
    void mutate(() => window.electronAPI.gitDiscardFile(reviewState.repoPath, file.path, workspaceId))
  }

  const commit = () => {
    if (!commitMessage.trim()) return
    void mutate(async () => {
      if (includeUnstaged) await window.electronAPI.gitStageAll(reviewState.repoPath, workspaceId)
      await window.electronAPI.gitCommit(reviewState.repoPath, commitMessage.trim(), workspaceId)
      setCommitMessage('')
    })
  }

  const createPr = () => {
    const branch = comparison?.currentBranch
    if (!branch) return
    void mutate(async () => {
      const result = await window.electronAPI.gitCreatePR(reviewState.repoPath, branch, workspaceId)
      if (result.ok) window.electronAPI.openExternalUrl(result.url)
      else throw new Error(result.message)
    })
  }

  const copyNotes = () => void navigator.clipboard.writeText(notesMarkdown(reviewState.notes ?? []))
  const copyApplyCommand = async () => {
    if (!comparison) return
    setBusy(true)
    try {
      const patches = await Promise.all(comparison.files.map((file) => limited(() => window.electronAPI.gitFileDiff(
        reviewState.repoPath,
        reviewState.spec,
        file.path,
        { contextLines: 3, allowLarge: true },
        workspaceId,
      ))))
      const patch = patches.map((item) => item.patch).filter(Boolean).join('\n')
      const marker = 'CATE_DIFF_PATCH'
      await navigator.clipboard.writeText(`git apply <<'${marker}'\n${patch}\n${marker}`)
    } catch (cause) {
      setError(errorMessage(cause, 'Could not copy patch'))
    } finally {
      setBusy(false)
    }
  }
  const saveNotes = async () => {
    const target = await window.electronAPI.saveFileDialog({ defaultName: 'review-notes.md' })
    if (target) await window.electronAPI.fsWriteFile(target, notesMarkdown(reviewState.notes ?? []), workspaceId)
  }

  const filteredFiles = useMemo(() => {
    const query = (reviewState.fileFilter ?? '').trim().toLowerCase()
    return comparison?.files.filter((file) => !query || file.path.toLowerCase().includes(query) || file.oldPath?.toLowerCase().includes(query)) ?? []
  }, [comparison, reviewState.fileFilter])
  const collapsed = new Set(reviewState.collapsedFiles ?? [])
  const allCollapsed = filteredFiles.length > 0 && filteredFiles.every((file) => collapsed.has(file.path))
  const workingMode = reviewState.spec.kind === 'uncommitted' || reviewState.spec.kind === 'unstaged'
  const stagedMode = reviewState.spec.kind === 'staged'
  const currentBranchMode = reviewState.spec.kind === 'branch'
    && reviewState.spec.target === comparison?.currentBranch
  const canWriteCurrentBranch = workingMode || stagedMode || currentBranchMode

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface-0 text-primary">
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b border-subtle bg-surface-1 flex-shrink-0">
        <select
          value={reviewState.spec.kind}
          onChange={(event) => setMode(event.target.value as GitComparisonSpec['kind'])}
          className="h-7 rounded-lg bg-surface-2 border border-subtle px-2 text-[12px] focus:outline-none"
        >
          {MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
        </select>
        {reviewState.spec.kind === 'commit' && (
          <SearchableRefInput
            id={`review-commit-${panelId}`}
            value={reviewState.spec.commit}
            options={commits.map((item) => ({ value: item.hash, label: item.message }))}
            onCommit={(commit) => update({ spec: { kind: 'commit', commit, ignoreWhitespace: reviewState.spec.ignoreWhitespace } })}
            ariaLabel="Search commits"
            className="h-7 min-w-0 max-w-[300px] rounded-lg bg-surface-2 border border-subtle px-2 text-[11px] font-mono focus:outline-none"
          />
        )}
        {reviewState.spec.kind === 'branch' && (
          <>
            <SearchableRefInput
              id={`review-base-${panelId}`}
              value={reviewState.spec.base}
              options={branches.map((branch) => ({ value: branch.name }))}
              onCommit={(base) => update({ spec: { kind: 'branch', base, target: reviewState.spec.kind === 'branch' ? reviewState.spec.target : '', ignoreWhitespace: reviewState.spec.ignoreWhitespace } })}
              ariaLabel="Search base branches"
              className="h-7 max-w-[180px] rounded-lg bg-surface-2 border border-subtle px-2 text-[11px] focus:outline-none"
            />
            <span className="text-muted">→</span>
            <SearchableRefInput
              id={`review-target-${panelId}`}
              value={reviewState.spec.target}
              options={branches.map((branch) => ({ value: branch.name }))}
              onCommit={(target) => update({ spec: { kind: 'branch', base: reviewState.spec.kind === 'branch' ? reviewState.spec.base : '', target, ignoreWhitespace: reviewState.spec.ignoreWhitespace } })}
              ariaLabel="Search target branches"
              className="h-7 max-w-[180px] rounded-lg bg-surface-2 border border-subtle px-2 text-[11px] focus:outline-none"
            />
          </>
        )}
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-[11px] text-muted tabular-nums mr-1">
            {comparison ? `${comparison.files.length} files ` : ''}
            <span className="text-diff-add">+{comparison?.additions ?? 0}</span>{' '}
            <span className="text-diff-del">-{comparison?.deletions ?? 0}</span>
          </span>
          <ToolbarButton label="Refresh" onClick={() => void refresh()} disabled={loading}><ArrowClockwise size={14} className={loading ? 'animate-spin' : ''} /></ToolbarButton>
          <ToolbarButton
            label={reviewState.display.split ? 'Switch to unified diff' : 'Switch to split diff'}
            onClick={() => updateDisplay({ split: !reviewState.display.split })}
          >
            {reviewState.display.split ? <Rows size={14} /> : <SplitHorizontal size={14} />}
          </ToolbarButton>
          <div ref={moreMenuRef} className="relative">
            <ToolbarButton label="More review options" active={moreOpen} onClick={() => setMoreOpen((open) => !open)}><DotsThree size={16} /></ToolbarButton>
            {moreOpen && (
              <div role="menu" className="absolute right-0 top-8 z-50 w-56 rounded-xl border border-subtle bg-surface-2 p-1 shadow-xl">
                <ReviewMenuButton label="Word differences" active={reviewState.display.wordDiff} onClick={() => updateDisplay({ wordDiff: !reviewState.display.wordDiff })}><Code size={14} /></ReviewMenuButton>
                <ReviewMenuButton label="Wrap lines" active={reviewState.display.wrap} onClick={() => updateDisplay({ wrap: !reviewState.display.wrap })}><PushPin size={14} /></ReviewMenuButton>
                <ReviewMenuButton label="Load full files" active={reviewState.display.fullFile} onClick={() => { updateDisplay({ fullFile: !reviewState.display.fullFile }); setDiffs({}) }}><File size={14} /></ReviewMenuButton>
                <ReviewMenuButton label="Image previews" active={reviewState.display.advancedPreview} onClick={() => updateDisplay({ advancedPreview: !reviewState.display.advancedPreview })}><ImageSquare size={14} /></ReviewMenuButton>
                <ReviewMenuButton label="Ignore whitespace" active={!!reviewState.spec.ignoreWhitespace} onClick={toggleWhitespace}><Check size={14} /></ReviewMenuButton>
                <div className="my-1 border-t border-subtle" />
                <ReviewMenuButton label="Copy git apply command" onClick={() => { setMoreOpen(false); void copyApplyCommand() }} disabled={!comparison || busy}><Code size={14} /></ReviewMenuButton>
                <ReviewMenuButton label="Copy review notes" onClick={() => { setMoreOpen(false); copyNotes() }} disabled={(reviewState.notes?.length ?? 0) === 0}><ClipboardText size={14} /></ReviewMenuButton>
                <ReviewMenuButton label="Save review notes" onClick={() => { setMoreOpen(false); void saveNotes() }} disabled={(reviewState.notes?.length ?? 0) === 0}><NotePencil size={14} /></ReviewMenuButton>
              </div>
            )}
          </div>
        </div>
      </div>

      {canWriteCurrentBranch && (
        <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 border-b border-subtle bg-surface-1 flex-shrink-0">
          {!currentBranchMode && <>
            <input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Commit message" className="h-7 flex-1 min-w-[180px] rounded-lg bg-surface-2 border border-subtle px-2 text-[12px] focus:outline-none" />
            <label className="flex items-center gap-1 text-[11px] text-secondary select-none">
              <input type="checkbox" checked={includeUnstaged} onChange={(event) => setIncludeUnstaged(event.target.checked)} /> Include unstaged changes
            </label>
            <button disabled={!commitMessage.trim() || busy} onClick={commit} className="h-7 px-3 rounded-lg bg-surface-2 hover:bg-hover disabled:opacity-30 text-[11px]">Commit</button>
          </>}
          <button disabled={busy} onClick={() => void mutate(() => window.electronAPI.gitPush(reviewState.repoPath, undefined, undefined, workspaceId))} className="h-7 px-3 rounded-lg bg-surface-2 hover:bg-hover disabled:opacity-30 text-[11px]">Push</button>
          <button disabled={busy || !comparison?.currentBranch} onClick={createPr} className="h-7 px-3 rounded-lg bg-surface-2 hover:bg-hover disabled:opacity-30 text-[11px] flex items-center gap-1"><GitPullRequest size={13} /> PR</button>
        </div>
      )}

      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-subtle flex-shrink-0">
        <FileMagnifyingGlass size={14} className="text-muted" />
        <input value={reviewState.fileFilter ?? ''} onChange={(event) => update({ fileFilter: event.target.value })} placeholder="Filter changed files" className="bg-transparent flex-1 min-w-0 text-[12px] focus:outline-none" />
        <Tooltip label={allCollapsed ? 'Expand all files' : 'Collapse all files'} placement="bottom">
          <button
            type="button"
            aria-label={allCollapsed ? 'Expand all files' : 'Collapse all files'}
            disabled={filteredFiles.length === 0}
            onClick={() => update({ collapsedFiles: allCollapsed ? [] : filteredFiles.map((file) => file.path) })}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-muted hover:text-primary hover:bg-hover disabled:opacity-30"
          >
            {allCollapsed ? <CaretDoubleDown size={14} /> : <CaretDoubleUp size={14} />}
          </button>
        </Tooltip>
      </div>

      {error && <div className="px-3 py-2 bg-red-500/10 text-red-400 text-[11px] border-b border-red-500/15">{error}</div>}

      <div className="flex-1 min-h-0 overflow-auto">
        {!loading && !error && filteredFiles.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-muted text-[12px]"><GitDiff size={28} /><span>No changes in this comparison</span></div>
        )}
        {filteredFiles.map((file) => {
          const isCollapsed = collapsed.has(file.path)
          const fileNotes = (reviewState.notes ?? []).filter((note) => note.path === file.path)
          return (
            <section key={file.path} data-review-file={encodeURIComponent(file.path)} className="border-b border-subtle scroll-mt-2">
              <div className="sticky top-0 z-10 flex items-center gap-2 px-2 py-1.5 bg-surface-2/95 backdrop-blur border-b border-subtle group">
                <button onClick={() => update({ collapsedFiles: isCollapsed ? [...collapsed].filter((path) => path !== file.path) : [...collapsed, file.path] })} className="text-muted hover:text-primary">{isCollapsed ? <CaretRight size={13} /> : <CaretDown size={13} />}</button>
                <span className={`w-4 text-center font-mono text-[11px] ${statusClass(file)}`}>{statusLabel(file)}</span>
                <span className="font-mono text-[11px] truncate flex-1" title={file.path}>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
                <span className="text-[10px] tabular-nums"><span className="text-diff-add">+{file.additions ?? '–'}</span> <span className="text-diff-del">-{file.deletions ?? '–'}</span></span>
                {fileNotes.length > 0 && <span className="text-[10px] text-blue-400">{fileNotes.length} note{fileNotes.length === 1 ? '' : 's'}</span>}
                <ToolbarButton label="Add file note" onClick={() => addNote(file.path, 'file', null, '')}><NotePencil size={13} /></ToolbarButton>
                <ToolbarButton label="Open file" onClick={() => useAppStore.getState().createEditor(workspaceId, absoluteFilePath(reviewState.repoPath, file.path))}><FileMagnifyingGlass size={13} /></ToolbarButton>
                {workingMode && file.working && <ToolbarButton label="Stage file" disabled={busy} onClick={() => void stage(file)}><Plus size={13} /></ToolbarButton>}
                {(stagedMode || (reviewState.spec.kind === 'uncommitted' && file.staged)) && <ToolbarButton label="Unstage file" disabled={busy} onClick={() => void unstage(file)}><Minus size={13} /></ToolbarButton>}
                {workingMode && file.working && <ToolbarButton label="Discard working changes" disabled={busy} onClick={() => discard(file)}><Trash size={13} /></ToolbarButton>}
              </div>
              <NoteRows notes={fileNotes.filter((note) => note.side === 'file')} />
              {!isCollapsed && reviewState.display.advancedPreview && imageMime(file.path)
                ? <ImageComparisonPreview repoPath={reviewState.repoPath} spec={reviewState.spec} file={file} workspaceId={workspaceId} />
                : !isCollapsed && <LazyDiffBody diff={diffs[file.path]} load={() => requestDiff(file)} allowLarge={() => requestDiff(file, true)} split={reviewState.display.split} wordDiff={reviewState.display.wordDiff} wrap={reviewState.display.wrap} notes={fileNotes} addNote={(side, line, context) => addNote(file.path, side, line, context)} />}
            </section>
          )
        })}
      </div>
    </div>
  )
}
