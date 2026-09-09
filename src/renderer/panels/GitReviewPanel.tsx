import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RotateCw as ArrowClockwise, ChevronDown as CaretDown, ChevronRight as CaretRight, Check, Clipboard as ClipboardText, Code, Ellipsis as DotsThree, File, FileSearch as FileMagnifyingGlass, GitCompareArrows as GitDiff, GitPullRequest, ImageIcon as ImageSquare, Minus, NotebookPen as NotePencil, Send as PaperPlaneTilt, Plus, Rows2 as Rows, Split as SplitHorizontal, Trash } from 'lucide-react'
import type {
  GitChangedFile,
  GitComparisonResult,
  GitComparisonSpec,
  GitDiffHunk,
  GitFileDiff,
  GitReviewNote,
  ReviewPanelState,
} from '../../shared/types'
import { type AgentId } from '../../shared/agents'
import type { PanelProps } from './types'
import { ReviewToolbar } from './ReviewToolbar'
import { LoadingState, Spinner } from '../ui/Spinner'
import { useAppStore } from '../stores/appStore'
import { errorMessage } from '../lib/errorMessage'
import { formatLocator, parseLocator } from '../../shared/runtimeLocator'
import { gitStatusStore, useGitStatusSnapshot } from '../stores/gitStatusStore'
import {
  handleCodingAgentMethod,
} from '../lib/agent/codingAgentDriver'
import { inspectReviewAgents, launchReviewAgent, trackReviewAgent, unavailableReviewAgents } from '../lib/review/reviewAgent'
import { openFileAsPanel } from '../lib/fs/fileRouting'
import { placementForPanel } from '../lib/workspace/canvasAccess'
import { AgentPickerPopover, ReviewActionButton, ReviewDisplayOptions, ReviewFileFilter, ReviewMenuButton, ReviewRunStatus, ReviewStats, ToolbarButton, type AgentChoice } from './ReviewControls'
import { HunkView, type NoteDraft } from './ReviewDiff'

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


type AgentAction = { kind: 'review' | 'changes' }

interface DiffLoadOptions {
  allowLarge?: boolean
  fullFile?: boolean
  contextLines?: number
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


function notesMarkdown(notes: GitReviewNote[]): string {
  const grouped = new Map<string, GitReviewNote[]>()
  for (const note of notes) grouped.set(note.path, [...(grouped.get(note.path) ?? []), note])
  const output = ['# Review notes', '']
  for (const [filePath, fileNotes] of grouped) {
    output.push(`## ${filePath}`, '')
    for (const note of fileNotes) {
      const location = note.side === 'file' ? 'File' : `${note.side} line ${note.line ?? '?'}`
      const state = note.outdated ? ' (outdated)' : note.status === 'resolved' ? ' (resolved)' : ''
      output.push(`- **${location}${state}:** ${note.body}`)
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

export function collapsedHunkGaps(hunks: GitDiffHunk[]): number[] {
  let previousOldEnd = 1
  let previousNewEnd = 1
  return hunks.map((hunk) => {
    if (hunk.oldStart === 0 && hunk.newStart === 0) return 0
    const hiddenLines = Math.max(
      Math.max(0, hunk.oldStart - previousOldEnd),
      Math.max(0, hunk.newStart - previousNewEnd),
    )
    previousOldEnd = hunk.oldStart + hunk.oldLines
    previousNewEnd = hunk.newStart + hunk.newLines
    return hiddenLines
  })
}

function reviewAgentPrompt(panelId: string, repoPath: string, spec: GitComparisonSpec): string {
  return `Review the changes shown in Cate's Review Panel ${panelId}.

This is a read-only code review. Do not edit files, commit, push, or otherwise change the repository.
Repository: ${repoPath}
Comparison: ${JSON.stringify(spec)}

Use the structured review API:
1. Run: cate panel set ${panelId}
2. Run: cate review inspect
3. Inspect the relevant files and diffs in the repository.
4. Record each actionable finding with:
   cate review note add --file <path> --line <number> --side old|new --body <finding> [--severity info|warning|error]
5. When finished, run: cate review complete

Prioritize correctness, regressions, security, and missing tests. Do not add notes for stylistic preferences unless they materially affect maintainability.`
}

function changesAgentPrompt(panelId: string, notes: GitReviewNote[]): string {
  const findings = notes.map((note, index) => {
    const location = note.side === 'file' ? note.path : `${note.path}:${note.line ?? '?'}`
    return `${index + 1}. [${note.severity ?? 'warning'}] ${location} — ${note.body}`
  }).join('\n')
  return `Address the open findings from Cate Review Panel ${panelId}.

${findings}

Make the requested changes in the current checkout, add or update focused tests, and run the relevant verification. Do not commit or push unless the user explicitly asks.`
}




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
  toggleNote,
  noteDraft,
  submitNote,
  cancelNote,
  fullFile,
  expandContext,
  expandFullFile,
}: {
  diff?: GitFileDiff
  load: () => void
  allowLarge: () => void
  split: boolean
  wordDiff: boolean
  wrap: boolean
  notes: GitReviewNote[]
  addNote: (side: 'old' | 'new', line: number, context: string) => void
  toggleNote: (noteId: string) => void
  noteDraft: NoteDraft | null
  submitNote: (body: string, severity: NonNullable<GitReviewNote['severity']>) => void
  cancelNote: () => void
  fullFile: boolean
  expandContext: () => void
  expandFullFile: () => void
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

  if (!diff) return <div ref={ref}><LoadingState label="Loading diff…" className="h-20 text-[11px]" /></div>
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

  const collapsedGaps = collapsedHunkGaps(diff.hunks)
  const renderedHunks: React.ReactNode[] = []
  for (const [hunkIndex, hunk] of diff.hunks.entries()) {
    const metadataOnly = hunk.oldStart === 0 && hunk.newStart === 0
    if (!fullFile && !metadataOnly) {
      const hiddenLines = collapsedGaps[hunkIndex]
      if (hiddenLines > 0) {
        renderedHunks.push(
          <div
            key={`fold-${hunkIndex}`}
            className="h-7 min-w-full flex items-center gap-2 border-y border-subtle bg-surface-2 px-3 text-[10px] text-muted hover:bg-hover hover:text-primary font-sans"
          >
            <button type="button" onClick={expandContext} title="Show more context" className="h-full flex items-center hover:text-primary">
              <CaretDown size={11} />
            </button>
            <span>{hiddenLines} unchanged line{hiddenLines === 1 ? '' : 's'}</span>
            <button type="button" onClick={expandFullFile} className="ml-auto text-[9px] hover:text-primary">Full file</button>
          </div>,
        )
      }
    }
    renderedHunks.push(
      <HunkView
        key={`${hunk.header}-${hunkIndex}`}
        hunk={hunk}
        split={split}
        wordDiff={wordDiff}
        wrap={wrap}
        notes={notes}
        addNote={addNote}
        toggleNote={toggleNote}
        noteDraft={noteDraft}
        submitNote={submitNote}
        cancelNote={cancelNote}
      />,
    )
  }
  if (!fullFile) {
    renderedHunks.push(
      <div
        key="expand-full-file"
        className="h-7 min-w-full flex items-center gap-2 border-t border-subtle bg-surface-2 px-3 text-[10px] text-muted hover:bg-hover hover:text-primary font-sans"
      >
        <button type="button" onClick={expandContext} title="Show more context" className="h-full flex items-center gap-2 hover:text-primary">
          <CaretDown size={11} />
          <span>More unchanged lines</span>
        </button>
        <button type="button" onClick={expandFullFile} className="ml-auto text-[9px] hover:text-primary">Full file</button>
      </div>,
    )
  }

  return (
    <div ref={ref} className={`font-mono text-[11px] leading-[1.45] ${wrap ? 'w-full min-w-0 whitespace-pre-wrap break-all' : 'w-max min-w-full whitespace-pre'}`}>
      {renderedHunks}
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

export default function GitReviewPanel({ panelId, workspaceId }: PanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const workspace = useAppStore((state) => state.workspaces.find((item) => item.id === workspaceId))
  const stored = workspace?.panels[panelId]?.reviewState
  const reviewState = stored ?? defaultReviewState(workspace?.rootPath ?? '')
  const gitSnapshot = useGitStatusSnapshot(reviewState.repoPath)
  const stateRef = useRef(reviewState)
  stateRef.current = reviewState
  const [comparison, setComparison] = useState<GitComparisonResult | null>(null)
  const [diffs, setDiffs] = useState<Record<string, GitFileDiff>>({})
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(() => new Set())
  const [contextLinesByFile, setContextLinesByFile] = useState<Record<string, number>>({})
  const diffsRef = useRef(diffs)
  const expandedFilesRef = useRef(expandedFiles)
  const contextLinesByFileRef = useRef(contextLinesByFile)
  const comparisonKeyRef = useRef('')
  const requestDiffRef = useRef<(file: GitChangedFile, options?: DiffLoadOptions) => void>(() => {})
  diffsRef.current = diffs
  expandedFilesRef.current = expandedFiles
  contextLinesByFileRef.current = contextLinesByFile
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [agentBusy, setAgentBusy] = useState(false)
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null)
  const [agentAction, setAgentAction] = useState<AgentAction | null>(null)
  const [agentChoices, setAgentChoices] = useState<AgentChoice[] | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<AgentId | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const agentPopoverRef = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
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

  useEffect(() => {
    if (!agentAction) return
    const close = (event: PointerEvent) => {
      if (!agentBusy && !agentPopoverRef.current?.contains(event.target as Node)) setAgentAction(null)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [agentAction, agentBusy])

  useEffect(() => {
    if (!agentAction) return
    let active = true
    setAgentChoices(null)
    setSelectedAgentId(null)
    const repoPath = reviewState.repoPath
    const fallbackPath = workspace?.rootPath
    const inspect = async () => {
      try {
        const choices = await inspectReviewAgents(repoPath, workspaceId, fallbackPath)
        if (!active) return
        setAgentChoices(choices)
        setSelectedAgentId(choices.find((choice) => choice.ready)?.agent.id ?? null)
      } catch (cause) {
        if (!active) return
        setAgentChoices(unavailableReviewAgents())
        setError(errorMessage(cause, 'Could not inspect available agents'))
      }
    }
    void inspect()
    return () => { active = false }
  }, [agentAction, reviewState.repoPath, workspace?.rootPath, workspaceId])

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
    const comparisonKey = JSON.stringify([state.repoPath, state.spec])
    const comparisonChanged = comparisonKeyRef.current !== comparisonKey
    comparisonKeyRef.current = comparisonKey
    const cachedDiffs = comparisonChanged ? {} : diffsRef.current
    if (comparisonChanged) {
      setComparison(null)
      setNoteDraft(null)
      diffsRef.current = {}
      expandedFilesRef.current = new Set()
      contextLinesByFileRef.current = {}
      setDiffs({})
      setExpandedFiles(new Set())
      setContextLinesByFile({})
    }
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.gitCompare(state.repoPath, state.spec, workspaceId)
      if (generation.current !== current) return
      setComparison(result)
      const paths = new Set(result.files.map((file) => file.path))
      setDiffs((loaded) => Object.fromEntries(Object.entries(loaded).filter(([filePath]) => paths.has(filePath))))
      for (const file of result.files) {
        if (!cachedDiffs[file.path]) continue
        const fullFile = state.display.fullFile || expandedFilesRef.current.has(file.path)
        requestDiffRef.current(file, {
          allowLarge: fullFile,
          fullFile,
          contextLines: contextLinesByFileRef.current[file.path] ?? 3,
        })
      }
      const latest = stateRef.current
      const notes = (latest.notes ?? []).map((note) => ({ ...note, outdated: !paths.has(note.path) }))
      if (notes.some((note, index) => note.outdated !== latest.notes?.[index]?.outdated)) {
        persist({ ...latest, notes })
      }
      requestAnimationFrame(() => {
        if (!state.focusedFile) return
        panelRef.current?.querySelector(`[data-review-file="${encodeURIComponent(state.focusedFile)}"]`)?.scrollIntoView({ block: 'start' })
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
      panelRef.current?.querySelector(`[data-review-file="${encodeURIComponent(reviewState.focusedFile ?? '')}"]`)?.scrollIntoView({ block: 'start' })
    })
  }, [reviewState.focusedFile, comparison])
  useEffect(() => {
    if (!reviewState.repoPath) return
    Promise.all([
      window.electronAPI.gitBranchList(reviewState.repoPath, workspaceId),
      window.electronAPI.gitLog(reviewState.repoPath, 100, workspaceId),
    ]).then(([branchResult, logResult]) => {
      setBranches(branchResult.branches)
      setCommits(logResult)
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

  const requestDiff = useCallback((file: GitChangedFile, options: DiffLoadOptions = {}) => {
    if (!options.allowLarge && !options.fullFile && options.contextLines === undefined && diffs[file.path]) return
    const state = stateRef.current
    const requestGeneration = generation.current
    void limited(() => window.electronAPI.gitFileDiff(
      state.repoPath,
      state.spec,
      file.path,
      {
        contextLines: state.display.fullFile || options.fullFile ? 999_999 : options.contextLines ?? 3,
        allowLarge: options.allowLarge,
      },
      workspaceId,
    )).then((diff) => {
      if (requestGeneration !== generation.current) return
      setDiffs((current) => ({ ...current, [file.path]: diff }))
      reanchorNotes(file.path, diff)
    }).catch((cause) => {
      if (requestGeneration === generation.current) setError(errorMessage(cause, `Could not load ${file.path}`))
    })
  }, [diffs, limited, workspaceId, reanchorNotes])
  requestDiffRef.current = requestDiff

  const toggleWhitespace = useCallback(() => {
    const spec = stateRef.current.spec
    update({ spec: { ...spec, ignoreWhitespace: !spec.ignoreWhitespace } as GitComparisonSpec })
  }, [update])

  const addNote = useCallback((draft: NoteDraft, body: string, severity: NonNullable<GitReviewNote['severity']>) => {
    const state = stateRef.current
    const note: GitReviewNote = {
      id: crypto.randomUUID(),
      path: draft.filePath,
      side: draft.side,
      line: draft.line,
      body,
      context: draft.context,
      contextHash: contextHash(draft.context),
      resolvedBase: comparison?.resolvedBase ?? null,
      resolvedTarget: comparison?.resolvedTarget ?? null,
      status: 'open',
      severity,
      author: 'human',
      createdAt: new Date().toISOString(),
    }
    persist({ ...state, notes: [...(state.notes ?? []), note] })
    setNoteDraft(null)
  }, [comparison, persist])

  const toggleNote = useCallback((noteId: string) => {
    const state = stateRef.current
    persist({
      ...state,
      notes: (state.notes ?? []).map((note) => note.id === noteId
        ? { ...note, status: note.status === 'resolved' ? 'open' : 'resolved' }
        : note),
    })
  }, [persist])

  const mutateFile = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      gitStatusStore.refresh(stateRef.current.repoPath)
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause, 'Could not update file'))
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const stageFile = (file: GitChangedFile) => void mutateFile(() =>
    window.electronAPI.gitStage(reviewState.repoPath, file.path, workspaceId))

  const unstageFile = (file: GitChangedFile) => void mutateFile(() =>
    window.electronAPI.gitUnstage(reviewState.repoPath, file.path, workspaceId))

  const discardFile = (file: GitChangedFile) => {
    if (file.untracked) {
      const local = parseLocator(reviewState.repoPath).runtimeId === 'local'
      const message = local
        ? `Move untracked file "${file.path}" to Trash?`
        : `Permanently delete untracked file "${file.path}" from the remote host? This cannot be undone.`
      if (!window.confirm(message)) return
      void mutateFile(() => window.electronAPI.fsTrashOrDelete(
        absoluteFilePath(reviewState.repoPath, file.path),
        workspaceId,
      ))
      return
    }
    if (!window.confirm(`Discard working changes in "${file.path}"? Staged changes will be preserved.`)) return
    void mutateFile(() => window.electronAPI.gitDiscardFile(reviewState.repoPath, file.path, workspaceId))
  }

  const launchAgent = useCallback(async (prompt: string, title: string, agentId: AgentId) => {
    return launchReviewAgent(workspaceId, panelId, stateRef.current.repoPath, prompt, title, agentId)
  }, [workspaceId, panelId])

  const reviewWithAgent = useCallback(async (agentId: AgentId) => {
    setAgentBusy(true)
    setError(null)
    try {
      const launched = await launchAgent(
        reviewAgentPrompt(panelId, stateRef.current.repoPath, stateRef.current.spec),
        'Review changes',
        agentId,
      )
      if (!launched) return
      trackReviewAgent(workspaceId, panelId, launched)
      setAgentAction(null)
    } catch (cause) {
      setError(errorMessage(cause, 'Could not start agent review'))
    } finally {
      setAgentBusy(false)
    }
  }, [launchAgent, panelId, workspaceId])

  const requestChanges = useCallback(async (agentId: AgentId | null, useSource: boolean) => {
    const notes = (stateRef.current.notes ?? []).filter((note) =>
      note.status !== 'resolved' && !note.outdated,
    )
    if (notes.length === 0) return
    setAgentBusy(true)
    setError(null)
    const prompt = changesAgentPrompt(panelId, notes)
    try {
      const source = useSource ? stateRef.current.sourceAgent : undefined
      if (source) {
        const outcome = await handleCodingAgentMethod(
          workspaceId,
          source.ownerPanelId,
          'cate.codingAgent.send',
          { runId: source.runId, prompt },
        )
        if (outcome.ok) {
          setAgentAction(null)
          return
        }
        setError('The original agent session is no longer available. Choose an agent to start a new session.')
        setAgentChoices(null)
        setSelectedAgentId(null)
        setAgentAction({ kind: 'changes' })
        return
      }
      if (!agentId) return
      const launched = await launchAgent(prompt, 'Address review findings', agentId)
      if (launched) setAgentAction(null)
    } catch (cause) {
      setError(errorMessage(cause, 'Could not request changes'))
    } finally {
      setAgentBusy(false)
    }
  }, [launchAgent, panelId, workspaceId])

  const copyNotes = () => void navigator.clipboard.writeText(notesMarkdown(reviewState.notes ?? []))
  const createPr = async () => {
    const branch = comparison?.currentBranch
    if (!branch) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.electronAPI.gitCreatePR(reviewState.repoPath, branch, workspaceId)
      if (result.ok) window.electronAPI.openExternalUrl(result.url)
      else throw new Error(result.message)
    } catch (cause) {
      setError(errorMessage(cause, 'Could not create pull request'))
    } finally {
      setBusy(false)
    }
  }
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
      const incomplete = patches.find((item) => item.patch == null)
      if (incomplete) throw new Error(`A complete patch cannot be created for ${incomplete.path}`)
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
  const openNotes = (reviewState.notes ?? []).filter((note) =>
    note.side !== 'file' && note.status !== 'resolved' && !note.outdated,
  )
  return (
    <div ref={panelRef} className="relative flex flex-col w-full min-w-0 h-full min-h-0 bg-surface-0 text-primary">
      <ReviewToolbar state={reviewState} workspaceId={workspaceId} panelId={panelId}>
        {reviewState.spec.kind === 'commit' && (
          <SearchableRefInput
            id={`review-commit-${panelId}`}
            value={reviewState.spec.commit}
            options={commits.map((item) => ({ value: item.hash, label: item.message }))}
            onCommit={(commit) => update({ spec: { kind: 'commit', commit, ignoreWhitespace: reviewState.spec.ignoreWhitespace } })}
            ariaLabel="Search commits"
            className="review-ref h-7 min-w-0 max-w-[300px] rounded-lg bg-surface-2 border border-subtle px-2 text-[11px] font-mono focus:outline-none"
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
              className="review-ref h-7 min-w-0 max-w-[180px] rounded-lg bg-surface-2 border border-subtle px-2 text-[11px] focus:outline-none"
            />
            <span className="text-muted">→</span>
            <SearchableRefInput
              id={`review-target-${panelId}`}
              value={reviewState.spec.target}
              options={branches.map((branch) => ({ value: branch.name }))}
              onCommit={(target) => update({ spec: { kind: 'branch', base: reviewState.spec.kind === 'branch' ? reviewState.spec.base : '', target, ignoreWhitespace: reviewState.spec.ignoreWhitespace } })}
              ariaLabel="Search target branches"
              className="review-ref h-7 min-w-0 max-w-[180px] rounded-lg bg-surface-2 border border-subtle px-2 text-[11px] focus:outline-none"
            />
          </>
        )}
        <div className="review-toolbar-actions flex shrink-0 items-center gap-1 ml-auto">
          <ReviewRunStatus state={reviewState} workspace={workspace} workspaceId={workspaceId} panelId={panelId} />
          <ReviewStats files={comparison?.files.length ?? 0} additions={comparison?.additions ?? 0} deletions={comparison?.deletions ?? 0} />
          <ToolbarButton label="Refresh" onClick={() => void refresh()} disabled={loading}>{loading ? <Spinner size={14} label="Refreshing changes" /> : <ArrowClockwise size={14} />}</ToolbarButton>
          <div ref={agentAction?.kind === 'review' ? agentPopoverRef : undefined} className="relative">
            <ReviewActionButton
              label="Review in terminal"
              onClick={() => {
                if (agentAction?.kind === 'review') { setAgentAction(null); return }
                setAgentChoices(null)
                setSelectedAgentId(null)
                setAgentAction({ kind: 'review' })
              }}
              disabled={agentBusy || reviewState.agentReview?.status === 'working'}
            />
            {agentAction?.kind === 'review' && (
              <AgentPickerPopover
                action={agentAction}
                choices={agentChoices}
                selectedAgentId={selectedAgentId}
                busy={agentBusy}
                onSelect={setSelectedAgentId}
                onClose={() => !agentBusy && setAgentAction(null)}
                onConfirm={() => selectedAgentId && void reviewWithAgent(selectedAgentId)}
              />
            )}
          </div>
          <div ref={agentAction?.kind === 'changes' ? agentPopoverRef : undefined} className="relative">
            <ReviewActionButton
              label={`Request changes${openNotes.length ? ` (${openNotes.length})` : ''}`}
              title={openNotes.length === 0 ? 'Add an open review note before requesting changes' : 'Send open findings to an agent'}
              onClick={() => {
                if (reviewState.sourceAgent) {
                  void requestChanges(null, true)
                  return
                }
                if (agentAction?.kind === 'changes') { setAgentAction(null); return }
                setAgentChoices(null)
                setSelectedAgentId(null)
                setAgentAction({ kind: 'changes' })
              }}
              disabled={agentBusy || openNotes.length === 0}
            >
              <PaperPlaneTilt size={14} />
            </ReviewActionButton>
            {agentAction?.kind === 'changes' && (
              <AgentPickerPopover
                action={agentAction}
                choices={agentChoices}
                selectedAgentId={selectedAgentId}
                busy={agentBusy}
                onSelect={setSelectedAgentId}
                onClose={() => !agentBusy && setAgentAction(null)}
                onConfirm={() => void requestChanges(selectedAgentId, false)}
              />
            )}
          </div>
          <ToolbarButton
            label={reviewState.display.split ? 'Switch to unified diff' : 'Switch to split diff'}
            onClick={() => updateDisplay({ split: !reviewState.display.split })}
          >
            {reviewState.display.split ? <Rows size={14} /> : <SplitHorizontal size={14} />}
          </ToolbarButton>
          {currentBranchMode && (
            <ToolbarButton label="Create pull request" disabled={busy} onClick={() => void createPr()}>
              <GitPullRequest size={14} />
            </ToolbarButton>
          )}
          <div ref={moreMenuRef} className="relative">
            <ToolbarButton label="More review options" active={moreOpen} onClick={() => setMoreOpen((open) => !open)}><DotsThree size={16} /></ToolbarButton>
            {moreOpen && (
              <div role="menu" className="absolute right-0 top-8 z-50 w-56 rounded-xl border border-subtle bg-surface-2 p-1 shadow-xl">
                <ReviewDisplayOptions display={reviewState.display} update={updateDisplay} />
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
      </ReviewToolbar>

      <ReviewFileFilter value={reviewState.fileFilter ?? ''} onChange={(fileFilter) => update({ fileFilter })} allCollapsed={allCollapsed} disabled={filteredFiles.length === 0} onToggleCollapsed={() => update({ collapsedFiles: allCollapsed ? [] : filteredFiles.map((file) => file.path) })} />

      {error && <div className="px-3 py-2 bg-red-500/10 text-red-400 text-[11px] border-b border-red-500/15">{error}</div>}

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {!loading && !error && filteredFiles.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-muted text-[12px]"><GitDiff size={28} /><span>No changes in this comparison</span></div>
        )}
        {filteredFiles.map((file) => {
          const isCollapsed = collapsed.has(file.path)
          const fileNotes = (reviewState.notes ?? []).filter((note) => note.path === file.path && note.side !== 'file')
          const fileDraft = noteDraft?.filePath === file.path ? noteDraft : null
          const contextLines = contextLinesByFile[file.path] ?? 3
          return (
            <section key={file.path} data-review-file={encodeURIComponent(file.path)} className="min-w-0 border-b border-subtle scroll-mt-2">
              <div className="sticky top-0 z-10 flex items-center gap-2 px-2 py-1.5 bg-surface-2/95 backdrop-blur border-b border-subtle group">
                <button onClick={() => update({ collapsedFiles: isCollapsed ? [...collapsed].filter((path) => path !== file.path) : [...collapsed, file.path] })} className="text-muted hover:text-primary">{isCollapsed ? <CaretRight size={13} /> : <CaretDown size={13} />}</button>
                <span className={`w-4 text-center font-mono text-[11px] ${statusClass(file)}`}>{statusLabel(file)}</span>
                <span className="font-mono text-[11px] truncate flex-1" title={file.path}>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
                <span className="text-[10px] tabular-nums"><span className="text-diff-add">+{file.additions ?? '–'}</span> <span className="text-diff-del">-{file.deletions ?? '–'}</span></span>
                {fileNotes.length > 0 && <span className="text-[10px] text-blue-400">{fileNotes.length} note{fileNotes.length === 1 ? '' : 's'}</span>}
                <ToolbarButton label="Open file" onClick={() => openFileAsPanel(
                  workspaceId,
                  absoluteFilePath(reviewState.repoPath, file.path),
                  undefined,
                  placementForPanel(workspaceId, panelId),
                )}><FileMagnifyingGlass size={13} /></ToolbarButton>
                {workingMode && file.working && <ToolbarButton label="Stage file" disabled={busy} onClick={() => stageFile(file)}><Plus size={13} /></ToolbarButton>}
                {(stagedMode || (reviewState.spec.kind === 'uncommitted' && file.staged)) && <ToolbarButton label="Unstage file" disabled={busy} onClick={() => unstageFile(file)}><Minus size={13} /></ToolbarButton>}
                {workingMode && file.working && <ToolbarButton label="Discard working changes" disabled={busy} onClick={() => discardFile(file)}><Trash size={13} /></ToolbarButton>}
              </div>
              {!isCollapsed && reviewState.display.advancedPreview && imageMime(file.path)
                ? <ImageComparisonPreview repoPath={reviewState.repoPath} spec={reviewState.spec} file={file} workspaceId={workspaceId} />
                : !isCollapsed && (
                  <div className="max-w-full overflow-x-auto overscroll-x-contain [container-type:inline-size]">
                    <LazyDiffBody
                      diff={diffs[file.path]}
                      load={() => requestDiff(file)}
                      allowLarge={() => requestDiff(file, { allowLarge: true, fullFile: expandedFiles.has(file.path) })}
                      split={reviewState.display.split}
                      wordDiff={reviewState.display.wordDiff}
                      wrap={reviewState.display.wrap}
                      notes={fileNotes}
                      addNote={(side, line, context) => setNoteDraft({ filePath: file.path, side, line, context })}
                      toggleNote={toggleNote}
                      noteDraft={fileDraft}
                      submitNote={(body, severity) => fileDraft && addNote(fileDraft, body, severity)}
                      cancelNote={() => setNoteDraft(null)}
                      fullFile={reviewState.display.fullFile || expandedFiles.has(file.path)}
                      expandContext={() => {
                        const nextContextLines = contextLines < 10 ? 10 : Math.min(contextLines * 2, 500)
                        setContextLinesByFile((current) => ({ ...current, [file.path]: nextContextLines }))
                        requestDiff(file, { allowLarge: true, contextLines: nextContextLines })
                      }}
                      expandFullFile={() => {
                        setExpandedFiles((current) => new Set(current).add(file.path))
                        requestDiff(file, { allowLarge: true, fullFile: true })
                      }}
                    />
                  </div>
                )}
            </section>
          )
        })}
      </div>

    </div>
  )
}
