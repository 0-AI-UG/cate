import React, { useState } from 'react'
import { Check, NotebookPen as NotePencil } from 'lucide-react'
import type { GitDiffHunk, GitDiffLine, GitReviewNote } from '../../shared/types'

export interface NoteDraft {
  filePath: string
  side: 'old' | 'new'
  line: number
  context: string
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
          ? <Check size={9} />
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
  readOnly = false,
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
  readOnly?: boolean
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
        {readOnly ? <><span className="w-10 shrink-0 text-right pr-2 text-muted/45 select-none">{line.oldLine}</span><span className="w-10 shrink-0 text-right pr-2 text-muted/45 select-none">{line.newLine}</span></> : <>
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
        </>}
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

const noReviewAction = () => {}
export function RecordedDiffHunk({ hunk, split = false, wordDiff = true, wrap = false }: { hunk: GitDiffHunk; split?: boolean; wordDiff?: boolean; wrap?: boolean }) {
  const lines = hunk.lines.filter((line) => line.kind !== 'meta')
  if (split) return <>{splitRows(lines).map((row, index) => <div key={index} className={`grid divide-x divide-subtle text-primary/75 ${wrap ? 'grid-cols-2 min-w-0' : 'grid-cols-[minmax(360px,max-content)_minmax(360px,max-content)] min-w-full'}`}><SplitCell line={row.left} side="old" other={row.right?.text} wordDiff={wordDiff} addNote={noReviewAction} readOnly /><SplitCell line={row.right} side="new" other={row.left?.text} wordDiff={wordDiff} addNote={noReviewAction} readOnly /></div>)}</>
  return <>{lines.map((line, index) => <UnifiedLine key={index} line={line} other={counterpart(lines, index)} wordDiff={wordDiff} readOnly notes={[]} addNote={noReviewAction} toggleNote={noReviewAction} noteDraft={null} submitNote={noReviewAction} cancelNote={noReviewAction} />)}</>
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
  readOnly = false,
}: {
  line?: GitDiffLine
  side: 'old' | 'new'
  other?: string
  wordDiff: boolean
  addNote: (side: 'old' | 'new', line: number, context: string) => void
  readOnly?: boolean
}) {
  const number = side === 'old' ? line?.oldLine : line?.newLine
  const kind = line?.kind
  return (
    <div className={`group flex ${readOnly ? 'min-w-0' : 'min-w-[360px]'} ${kind === 'delete' ? 'bg-diff-del' : kind === 'add' ? 'bg-diff-add' : ''}`}>
      {readOnly ? <span className="w-10 shrink-0 text-right pr-2 text-muted/45 select-none">{number ?? ''}</span> : <>
      <button type="button" title={number == null ? undefined : `Add note on ${side} line ${number}`} className="w-10 shrink-0 text-right pr-2 text-muted/45 hover:text-primary" disabled={number == null} onClick={() => number != null && line && addNote(side, number, line.text)}>{number ?? ''}</button>
      <button type="button" aria-label={number == null ? undefined : `Add review note on ${side} line ${number}`} className="w-5 shrink-0 flex items-center justify-center text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-primary disabled:pointer-events-none" disabled={number == null} onClick={() => number != null && line && addNote(side, number, line.text)}>{number != null && <NotePencil size={10} />}</button>
      </>}
      <span className={`w-4 shrink-0 ${kind === 'delete' ? 'text-diff-del' : kind === 'add' ? 'text-diff-add' : ''}`}>{kind === 'delete' ? '-' : kind === 'add' ? '+' : ' '}</span>
      <span className="flex-1 pr-2">{line ? wordHighlight(line.text, other, wordDiff) : ' '}</span>
    </div>
  )
}

export function HunkView({ hunk, split, wordDiff, wrap, notes, addNote, toggleNote, noteDraft, submitNote, cancelNote }: {
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
