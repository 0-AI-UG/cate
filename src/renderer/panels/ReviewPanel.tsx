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
  PaperPlaneTilt,
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
import { AGENTS, type AgentDef, type AgentId } from '../../shared/agents'
import type { PanelProps } from './types'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { Tooltip } from '../ui/Tooltip'
import { errorMessage } from '../lib/errorMessage'
import { formatLocator, parseLocator } from '../../shared/runtimeLocator'
import { gitStatusStore, useGitStatusSnapshot } from '../stores/gitStatusStore'
import { requestPanelTarget } from '../lib/panelTargetPicker'
import {
  codingAgentTerminalError,
  handleCodingAgentMethod,
} from '../lib/agent/codingAgentDriver'
import {
  evaluateAgentCliHooks,
  inspectAgentCliHooks,
} from '../lib/agent/agentCliHooks'
import { getAgentLogoById } from '../lib/agent/agentLogos'
import { pathKey } from '../../shared/pathUtils'
import { placementForPanel } from '../lib/workspace/canvasAccess'

const MODES: Array<{ value: GitComparisonSpec['kind']; label: string }> = [
  { value: 'uncommitted', label: 'All Changes' },
  { value: 'unstaged', label: 'Changes' },
  { value: 'staged', label: 'Staged Changes' },
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

interface NoteDraft {
  filePath: string
  side: 'old' | 'new'
  line: number
  context: string
}

interface AgentChoice {
  agent: AgentDef
  ready: boolean
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

const ReviewActionButton: React.FC<{
  label: string
  title?: string
  disabled?: boolean
  onClick: () => void
  children?: React.ReactNode
}> = ({ label, title, disabled, onClick, children }) => (
  <button
    type="button"
    aria-label={label}
    title={title}
    disabled={disabled}
    onClick={onClick}
    className="h-7 px-2.5 rounded-lg flex items-center gap-1.5 border border-subtle bg-surface-2 text-[11px] text-secondary hover:text-primary hover:bg-hover disabled:opacity-30 disabled:pointer-events-none transition-colors"
  >
    {children}
    <span>{label}</span>
  </button>
)

export function ReviewNoteComposer({
  draft,
  onClose,
  onSubmit,
}: {
  draft: NoteDraft
  onClose: () => void
  onSubmit: (body: string, severity: NonNullable<GitReviewNote['severity']>) => void
}) {
  const [body, setBody] = useState('')
  const [severity, setSeverity] = useState<NonNullable<GitReviewNote['severity']>>('warning')
  const submit = () => {
    const value = body.trim()
    if (value) onSubmit(value, severity)
  }
  return (
    <form
      onSubmit={(event) => { event.preventDefault(); submit() }}
      className="flex w-full min-w-0 flex-col overflow-hidden rounded-lg border border-subtle bg-surface-1 font-sans whitespace-normal"
    >
      <div className="flex items-center gap-2 px-2.5 pt-2 text-[9px] text-muted">
        <span className="font-medium text-secondary">You</span>
        <span className="ml-auto">Local comment on line {draft.side === 'new' ? 'R' : 'L'}{draft.line}</span>
      </div>
      <textarea
        autoFocus
        aria-label="Review note"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
        placeholder="Request a change…"
        rows={2}
        className="min-h-14 w-full resize-y bg-transparent px-2.5 py-2 text-[11px] leading-relaxed text-primary placeholder:text-muted focus:outline-none"
      />
      <div className="flex items-center gap-1.5 px-2 pb-2">
        <select
          aria-label="Review note severity"
          value={severity}
          onChange={(event) => setSeverity(event.target.value as NonNullable<GitReviewNote['severity']>)}
          className="h-6 rounded border border-subtle bg-surface-2 px-1.5 text-[9px] text-secondary focus:outline-none"
        >
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="error">Blocking</option>
        </select>
        <button type="button" onClick={onClose} className="ml-auto h-6 px-2 rounded text-[10px] text-muted hover:text-primary hover:bg-hover">Cancel</button>
        <button type="submit" disabled={!body.trim()} className="h-6 rounded bg-focus-blue px-2.5 text-[10px] text-white disabled:bg-surface-2 disabled:text-muted">Comment</button>
      </div>
    </form>
  )
}

function AgentPickerPopover({
  action,
  choices,
  selectedAgentId,
  busy,
  onSelect,
  onClose,
  onConfirm,
}: {
  action: AgentAction
  choices: AgentChoice[] | null
  selectedAgentId: AgentId | null
  busy: boolean
  onSelect: (agentId: AgentId) => void
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <div role="dialog" aria-label={action.kind === 'review' ? 'Choose terminal review CLI' : 'Choose terminal changes CLI'} className="absolute right-0 top-9 z-50 w-64 rounded-lg border border-subtle bg-surface-2 p-1.5 shadow-xl">
      <p className="px-1 pb-1.5 text-[10px] text-muted">
        {action.kind === 'review'
          ? 'Choose a terminal CLI to review this diff.'
          : 'Choose a terminal CLI to address the open review notes.'}
      </p>
      {choices === null ? (
        <div className="py-4 text-center text-[10px] text-muted">Checking terminal CLIs…</div>
      ) : (
        <div role="radiogroup" aria-label="Terminal CLI" className="grid grid-cols-3 gap-1">
          {choices.map(({ agent, ready }) => {
            const selected = selectedAgentId === agent.id
            const logo = getAgentLogoById(agent.id)
            return (
              <button
                key={agent.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!ready}
                title={ready ? agent.displayName : `${agent.displayName}: hooks not enabled`}
                onClick={() => onSelect(agent.id)}
                className={`relative h-12 min-w-0 rounded-md border px-1 py-1 flex flex-col items-center justify-center gap-0.5 transition-colors disabled:opacity-35 ${selected ? 'border-focus-blue bg-focus-blue/10' : 'border-transparent hover:bg-hover'}`}
              >
                {logo
                  ? <img src={logo} alt="" className="w-4 h-4 object-contain shrink-0" />
                  : <span className="w-4 h-4 shrink-0 rounded bg-surface-4 flex items-center justify-center text-[9px]">{agent.displayName[0]}</span>}
                <span className="w-full truncate text-center text-[9px] text-primary">{agent.displayName}</span>
                {!ready && <span className="absolute right-1 top-1 w-1.5 h-1.5 rounded-full bg-amber-400" />}
              </button>
            )
          })}
        </div>
      )}
      <div className="mt-1.5 flex justify-end gap-1 border-t border-subtle pt-1.5">
        <button type="button" onClick={onClose} disabled={busy} className="h-6 px-2 rounded text-[10px] text-muted hover:text-primary hover:bg-hover disabled:opacity-40">Cancel</button>
        <button type="button" onClick={onConfirm} disabled={busy || !selectedAgentId} className="h-6 px-2 rounded bg-focus-blue text-white text-[10px] disabled:opacity-40">
          {busy ? 'Starting…' : action.kind === 'review' ? 'Start review' : 'Send request'}
        </button>
      </div>
    </div>
  )
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

function ReviewNoteRow({ note, toggleNote }: { note: GitReviewNote; toggleNote: (noteId: string) => void }) {
  const inactive = note.outdated || note.status === 'resolved'
  const severityColor = note.severity === 'error'
    ? 'bg-red-400'
    : note.severity === 'info' ? 'bg-blue-400' : 'bg-amber-400'
  return (
    <div className={`flex items-start gap-1.5 px-2 py-1.5 text-[10.5px] leading-relaxed ${inactive ? 'text-muted opacity-60' : 'text-primary/85'}`}>
      <button
        type="button"
        aria-label={note.status === 'resolved' ? 'Reopen review comment' : 'Resolve review comment'}
        onClick={() => toggleNote(note.id)}
        className="mt-[2px] w-3.5 h-3.5 shrink-0 rounded-full flex items-center justify-center text-blue-400 hover:bg-hover hover:text-primary"
      >
        {note.status === 'resolved'
          ? <Check size={9} weight="bold" />
          : <span className="w-2 h-2 rounded-full border border-current" />}
      </button>
      <span title={note.severity ?? 'warning'} className={`mt-[5px] w-1.5 h-1.5 shrink-0 rounded-full ${severityColor}`} />
      <span className={inactive ? 'line-through' : ''}>{note.author === 'agent' && <span className="mr-1 text-[9px] text-muted">Agent</span>}{note.body}</span>
    </div>
  )
}

function InlineCommentThread({ notes, toggleNote }: { notes: GitReviewNote[]; toggleNote: (noteId: string) => void }) {
  if (notes.length === 0) return null
  return (
    <div className="flex w-full min-w-0 flex-col divide-y divide-subtle overflow-hidden rounded border border-subtle bg-surface-1/70 font-sans whitespace-normal">
      {notes.map((note) => <ReviewNoteRow key={note.id} note={note} toggleNote={toggleNote} />)}
    </div>
  )
}

export function UnifiedLine({
  line,
  other,
  wordDiff,
  notes,
  addNote,
  toggleNote,
  noteDraft,
  submitNote,
  cancelNote,
}: {
  line: GitDiffLine
  other?: string
  wordDiff: boolean
  notes: GitReviewNote[]
  addNote: (side: 'old' | 'new', line: number, context: string) => void
  toggleNote: (noteId: string) => void
  noteDraft: NoteDraft | null
  submitNote: (body: string, severity: NonNullable<GitReviewNote['severity']>) => void
  cancelNote: () => void
}) {
  const side = line.kind === 'delete' ? 'old' : 'new'
  const lineNumber = side === 'old' ? line.oldLine : line.newLine
  const background = line.kind === 'add' ? 'bg-diff-add' : line.kind === 'delete' ? 'bg-diff-del' : ''
  const color = line.kind === 'add' ? 'text-diff-add' : line.kind === 'delete' ? 'text-diff-del' : 'text-primary/75'
  const lineNotes = lineNumber == null ? [] : notes.filter((note) => note.side === side && note.line === lineNumber)
  const isEditing = noteDraft?.side === side && noteDraft.line === lineNumber
  return (
    <>
      <div className={`group flex min-w-full ${background}`}>
        <button
          type="button"
          title={lineNumber == null ? undefined : `Add note on ${side} line ${lineNumber}`}
          className="w-10 shrink-0 text-right pr-2 text-muted/45 select-none hover:text-primary"
          disabled={lineNumber == null}
          onClick={() => lineNumber != null && addNote(side, lineNumber, line.text)}
        >
          {line.oldLine ?? ''}
        </button>
        <button
          type="button"
          title={lineNumber == null ? undefined : `Add note on ${side} line ${lineNumber}`}
          className="w-10 shrink-0 text-right pr-2 text-muted/45 select-none hover:text-primary"
          disabled={lineNumber == null}
          onClick={() => lineNumber != null && addNote(side, lineNumber, line.text)}
        >
          {line.newLine ?? ''}
        </button>
        <button
          type="button"
          aria-label={lineNumber == null ? undefined : `Add review note on ${side} line ${lineNumber}`}
          disabled={lineNumber == null}
          onClick={() => lineNumber != null && addNote(side, lineNumber, line.text)}
          className="w-5 shrink-0 flex items-center justify-center text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-primary disabled:pointer-events-none"
        >
          {lineNumber != null && <NotePencil size={10} />}
        </button>
        <span className={`w-4 shrink-0 select-none ${color}`}>{line.kind === 'add' ? '+' : line.kind === 'delete' ? '-' : ' '}</span>
        <span className={`flex-1 pr-4 ${color}`}>{wordHighlight(line.text, other, wordDiff && (line.kind === 'add' || line.kind === 'delete'))}</span>
      </div>
      {(isEditing || lineNotes.length > 0) && (
        <div className="sticky left-0 flex w-[100cqw] min-w-0 border-y border-blue-500/15 bg-blue-500/[0.035]">
          <div className="w-[116px] shrink-0 border-r border-blue-500/15 bg-surface-1/50" />
          <div className="min-w-0 flex-1 space-y-1.5 px-2 py-1.5">
            <InlineCommentThread notes={lineNotes} toggleNote={toggleNote} />
            {isEditing && <ReviewNoteComposer draft={noteDraft} onClose={cancelNote} onSubmit={submitNote} />}
          </div>
        </div>
      )}
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
    <div className={`group flex min-w-[360px] ${kind === 'delete' ? 'bg-diff-del' : kind === 'add' ? 'bg-diff-add' : ''}`}>
      <button type="button" title={number == null ? undefined : `Add note on ${side} line ${number}`} className="w-10 shrink-0 text-right pr-2 text-muted/45 hover:text-primary" disabled={number == null} onClick={() => number != null && line && addNote(side, number, line.text)}>{number ?? ''}</button>
      <button type="button" aria-label={number == null ? undefined : `Add review note on ${side} line ${number}`} className="w-5 shrink-0 flex items-center justify-center text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-primary disabled:pointer-events-none" disabled={number == null} onClick={() => number != null && line && addNote(side, number, line.text)}>{number != null && <NotePencil size={10} />}</button>
      <span className={`w-4 shrink-0 ${kind === 'delete' ? 'text-diff-del' : kind === 'add' ? 'text-diff-add' : ''}`}>{kind === 'delete' ? '-' : kind === 'add' ? '+' : ' '}</span>
      <span className="flex-1 pr-2">{line ? wordHighlight(line.text, other, wordDiff) : ' '}</span>
    </div>
  )
}

function HunkView({ hunk, split, wordDiff, wrap, notes, addNote, toggleNote, noteDraft, submitNote, cancelNote }: {
  hunk: GitDiffHunk
  split: boolean
  wordDiff: boolean
  wrap: boolean
  notes: GitReviewNote[]
  addNote: (side: 'old' | 'new', line: number, context: string) => void
  toggleNote: (noteId: string) => void
  noteDraft: NoteDraft | null
  submitNote: (body: string, severity: NonNullable<GitReviewNote['severity']>) => void
  cancelNote: () => void
}) {
  const metadataOnly = hunk.lines.every((line) => line.kind === 'meta')
  return (
    <div>
      {metadataOnly && <div className="px-3 py-1 text-blue-400/70 bg-blue-500/[0.07] border-y border-blue-500/10 select-text">{hunk.header}</div>}
      {metadataOnly ? hunk.lines.map((line, index) => (
        <div key={index} className="px-3 py-0.5 text-muted">{line.text}</div>
      )) : split ? splitRows(hunk.lines).map((row, index) => {
        const leftNotes = notes.filter((note) => note.side === 'old' && note.line === row.left?.oldLine)
        const rightNotes = notes.filter((note) => note.side === 'new' && note.line === row.right?.newLine)
        const editingLeft = noteDraft?.side === 'old' && noteDraft.line === row.left?.oldLine
        const editingRight = noteDraft?.side === 'new' && noteDraft.line === row.right?.newLine
        const hasComments = editingLeft || editingRight || leftNotes.length > 0 || rightNotes.length > 0
        const gridClass = wrap
          ? 'grid-cols-2 min-w-0'
          : 'grid-cols-[minmax(360px,max-content)_minmax(360px,max-content)] min-w-full'
        return (
          <React.Fragment key={index}>
            <div className={`grid divide-x divide-subtle text-primary/75 ${gridClass}`}>
              <SplitCell line={row.left} side="old" other={row.right?.text} wordDiff={wordDiff} addNote={addNote} />
              <SplitCell line={row.right} side="new" other={row.left?.text} wordDiff={wordDiff} addNote={addNote} />
            </div>
            {hasComments && (
              <div className="sticky left-0 grid w-[100cqw] min-w-0 grid-cols-2 divide-x divide-blue-500/15 border-y border-blue-500/15 bg-blue-500/[0.035]">
                <div className="flex min-w-0">
                  <div className="w-[76px] shrink-0 border-r border-blue-500/15 bg-surface-1/50" />
                  <div className="min-w-0 flex-1 space-y-1.5 px-2 py-1.5">
                    <InlineCommentThread notes={leftNotes} toggleNote={toggleNote} />
                    {editingLeft && <ReviewNoteComposer draft={noteDraft} onClose={cancelNote} onSubmit={submitNote} />}
                  </div>
                </div>
                <div className="flex min-w-0">
                  <div className="w-[76px] shrink-0 border-r border-blue-500/15 bg-surface-1/50" />
                  <div className="min-w-0 flex-1 space-y-1.5 px-2 py-1.5">
                    <InlineCommentThread notes={rightNotes} toggleNote={toggleNote} />
                    {editingRight && <ReviewNoteComposer draft={noteDraft} onClose={cancelNote} onSubmit={submitNote} />}
                  </div>
                </div>
              </div>
            )}
          </React.Fragment>
        )
      }) : hunk.lines.map((line, index) => (
        <UnifiedLine key={index} line={line} other={counterpart(hunk.lines, index)} wordDiff={wordDiff} notes={notes} addNote={addNote} toggleNote={toggleNote} noteDraft={noteDraft} submitNote={submitNote} cancelNote={cancelNote} />
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
  const [trackingBranch, setTrackingBranch] = useState<string | null>(null)
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
    const repoPath = parseLocator(reviewState.repoPath).path
    const fallbackPath = workspace?.rootPath
    const inspect = async () => {
      try {
        const [states, fallbackStates] = await Promise.all([
          inspectAgentCliHooks(repoPath),
          fallbackPath && fallbackPath !== repoPath ? inspectAgentCliHooks(fallbackPath) : Promise.resolve([]),
        ])
        if (!active) return
        const fallbackById = new Map(fallbackStates.map((state) => [state.agent.id, state]))
        const hookConfig = useSettingsStore.getState().agentHookInjection[workspaceId]
        const choices = states.map((state) => ({
          agent: state.agent,
          ready: evaluateAgentCliHooks(state, hookConfig, fallbackById.get(state.agent.id)).ready,
        }))
        setAgentChoices(choices)
        setSelectedAgentId(choices.find((choice) => choice.ready)?.agent.id ?? null)
      } catch (cause) {
        if (!active) return
        setAgentChoices(AGENTS.map((agent) => ({ agent, ready: false })))
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

  const reviewerRun = reviewState.agentReview
    ? Object.values(workspace?.panels ?? {}).find((panel) =>
        panel.codingAgentRun?.id === reviewState.agentReview?.runId,
      )?.codingAgentRun
    : undefined
  useEffect(() => {
    if (reviewState.agentReview?.status !== 'working' || !reviewerRun?.endedAt) return
    update({
      agentReview: {
        ...reviewState.agentReview,
        status: 'failed',
        completedAt: reviewerRun.endedAt,
      },
    })
  }, [reviewState.agentReview, reviewerRun?.endedAt, update])

  const refresh = useCallback(async () => {
    const current = ++generation.current
    const state = stateRef.current
    if (!state.repoPath) return
    const comparisonKey = JSON.stringify([state.repoPath, state.spec])
    const comparisonChanged = comparisonKeyRef.current !== comparisonKey
    comparisonKeyRef.current = comparisonKey
    const cachedDiffs = comparisonChanged ? {} : diffsRef.current
    if (comparisonChanged) {
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
      const notes = (state.notes ?? []).map((note) => ({ ...note, outdated: !paths.has(note.path) }))
      if (notes.some((note, index) => note.outdated !== state.notes?.[index]?.outdated)) {
        persist({ ...state, notes })
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
    const currentWorkspace = useAppStore.getState().workspaces.find((item) => item.id === workspaceId)
    if (!currentWorkspace) throw new Error('Workspace not found')
    const existingPanelIds = Object.values(currentWorkspace.panels)
      .filter((panel) => panel.type === 'terminal')
      .filter((panel) => codingAgentTerminalError(workspaceId, panel.id, panelId) === null)
      .map((panel) => panel.id)
    const target = await requestPanelTarget({
      workspaceId,
      panelType: 'terminal',
      availability: 'both',
      existingPanelIds,
      sourcePanelId: panelId,
    })
    if (!target) return null
    const repoPath = parseLocator(stateRef.current.repoPath).path
    const worktree = currentWorkspace.worktrees?.find((candidate) =>
      pathKey(parseLocator(candidate.path).path) === pathKey(repoPath),
    )
    const outcome = await handleCodingAgentMethod(
      workspaceId,
      panelId,
      'cate.codingAgent.create',
      {
        agentId,
        prompt,
        title,
        background: false,
        _cateOriginCwd: repoPath,
        ...(worktree ? { worktreeId: worktree.id } : {}),
        ...(target.kind === 'existing' ? { terminalPanelId: target.panelId } : {}),
      },
      target.kind === 'new' ? { placement: target.placement } : undefined,
    )
    if (!outcome.ok) throw new Error(outcome.error)
    const result = outcome.result as { id?: unknown; panelId?: unknown } | null
    if (typeof result?.id !== 'string' || typeof result.panelId !== 'string') {
      throw new Error('Agent launch did not return a run')
    }
    return { runId: result.id, terminalPanelId: result.panelId }
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
      update({
        agentReview: {
          ...launched,
          status: 'working',
          startedAt: Date.now(),
        },
      })
      setAgentAction(null)
    } catch (cause) {
      setError(errorMessage(cause, 'Could not start agent review'))
    } finally {
      setAgentBusy(false)
    }
  }, [launchAgent, panelId, update])

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
    <div ref={panelRef} className="relative flex flex-col h-full min-h-0 bg-surface-0 text-primary">
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
          {reviewState.agentReview && (
            <span className={`text-[10px] mr-1 ${reviewState.agentReview.status === 'complete' ? 'text-green-400' : reviewState.agentReview.status === 'failed' ? 'text-red-400' : 'text-blue-400'}`}>
              Terminal review: {reviewState.agentReview.status}
            </span>
          )}
          <span className="text-[11px] text-muted tabular-nums mr-1">
            {comparison ? `${comparison.files.length} files ` : ''}
            <span className="text-diff-add">+{comparison?.additions ?? 0}</span>{' '}
            <span className="text-diff-del">-{comparison?.deletions ?? 0}</span>
          </span>
          <ToolbarButton label="Refresh" onClick={() => void refresh()} disabled={loading}><ArrowClockwise size={14} className={loading ? 'animate-spin' : ''} /></ToolbarButton>
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
                <ToolbarButton label="Open file" onClick={() => useAppStore.getState().createEditor(
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
