import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  RotateCw as ArrowClockwise,
  ChevronDown as CaretDown,
  ChevronRight as CaretRight,
  Check,
  Clipboard as ClipboardText,
  Code,
  Ellipsis as DotsThree,
  File,
  FileSearch as FileMagnifyingGlass,
  GitCompareArrows as GitDiff,
  GitPullRequest,
  ImageIcon as ImageSquare,
  Minus,
  NotebookPen as NotePencil,
  Send as PaperPlaneTilt,
  Plus,
  Rows2 as Rows,
  Split as SplitHorizontal,
  Trash,
} from 'lucide-react'
import { LoadingState, Spinner, POPOVER_SURFACE } from '../../kernel/interaction'
import { clientUi } from '@kernel/interaction'
import { documentStoreFor } from '@client/document'
import type { AgentId } from '@services/agents/contract'
import type { GitChangedFile, GitFileDiff } from '@workspace/repository/contract'
import { freshRecord } from '@panels/definitions'
import { notesMarkdown, openFindings, type ReviewNote, type ReviewNoteSeverity, type ReviewSnapshot } from '@panels/review/contract'
import { placeNear, revealPanel } from './parts/openReview'
import { pickReviewTerminal } from './parts/pickTerminal'
import { ReviewToolbar } from './ReviewToolbar'
import { AgentPickerPopover, ReviewActionButton, ReviewDisplayOptions, ReviewFileFilter, ReviewMenuButton, ReviewRunStatus, ReviewStats, ToolbarButton } from './ReviewControls'
import { HunkView, collapsedHunkGaps, type NoteDraft } from './ReviewDiff'
import { sendOrShow, useAgentPicker, useReviewDiffs, useReviewView, type ReviewSend } from './useReview'

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

function joinPath(root: string, relative: string): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[/\\]+$/, '')}${separator}${relative}`
}

function SearchableRefInput({ id, value, options, onCommit, className, ariaLabel }: {
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

function LazyDiffBody({ diff, error, load, allowLarge, split, wordDiff, wrap, notes, addNote, toggleNote, noteDraft, submitNote, cancelNote, fullFile, expandContext, expandFullFile }: {
  diff?: GitFileDiff
  error?: string
  load: () => void
  allowLarge: () => void
  split: boolean
  wordDiff: boolean
  wrap: boolean
  notes: ReviewNote[]
  addNote: (side: 'old' | 'new', line: number, context: string) => void
  toggleNote: (noteId: string) => void
  noteDraft: NoteDraft | null
  submitNote: (body: string, severity: ReviewNoteSeverity) => void
  cancelNote: () => void
  fullFile: boolean
  expandContext: () => void
  expandFullFile: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (diff || error) return
    if (typeof IntersectionObserver === 'undefined') { load(); return }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        load()
        observer.disconnect()
      }
    }, { rootMargin: '600px' })
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [diff, error, load])

  if (!diff && error) return <div ref={ref} className="px-4 py-5 text-center text-[11px] text-red-400">{error}</div>
  if (!diff) return <div ref={ref}><LoadingState label="Loading diff" className="h-20 text-[11px]" /></div>
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
    const hiddenLines = collapsedGaps[hunkIndex]
    if (!fullFile && !metadataOnly && hiddenLines > 0) {
      renderedHunks.push(
        <div key={`fold-${hunkIndex}`} className="h-7 min-w-full flex items-center gap-2 border-y border-subtle bg-surface-2 px-3 text-[10px] text-muted hover:bg-hover hover:text-primary font-sans">
          <button type="button" onClick={expandContext} title="Show more context" className="h-full flex items-center hover:text-primary">
            <CaretDown size={11} />
          </button>
          <span>{hiddenLines} unchanged line{hiddenLines === 1 ? '' : 's'}</span>
          <button type="button" onClick={expandFullFile} className="ml-auto text-[9px] hover:text-primary">Full file</button>
        </div>,
      )
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
      <div key="expand-full-file" className="h-7 min-w-full flex items-center gap-2 border-t border-subtle bg-surface-2 px-3 text-[10px] text-muted hover:bg-hover hover:text-primary font-sans">
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

/** Before/after images, fetched from the session while shown. */
function ImageComparisonPreview({ send, file, comparisonKey }: { send: ReviewSend; file: GitChangedFile; comparisonKey: string }) {
  const mime = imageMime(file.path)
  const [images, setImages] = useState<{ old: string | null; new: string | null } | null>(null)
  useEffect(() => {
    if (!mime) return
    let live = true
    setImages(null)
    send({ kind: 'images', path: file.path, oldPath: file.oldPath }).then(
      (result) => { if (live) setImages(result as { old: string | null; new: string | null }) },
      () => { if (live) setImages({ old: null, new: null }) },
    )
    return () => { live = false }
  }, [send, file.path, file.oldPath, mime, comparisonKey])
  if (!mime) return null
  const urls = { old: images?.old ? `data:${mime};base64,${images.old}` : null, new: images?.new ? `data:${mime};base64,${images.new}` : null }
  return (
    <div className="grid grid-cols-2 divide-x divide-subtle bg-[linear-gradient(45deg,var(--surface-2)_25%,transparent_25%),linear-gradient(-45deg,var(--surface-2)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--surface-2)_75%),linear-gradient(-45deg,transparent_75%,var(--surface-2)_75%)] bg-[length:18px_18px]">
      <div className="p-4 min-h-28 relative"><span className="absolute top-1 left-2 text-[10px] text-muted bg-surface-0/80 px-1 rounded">Before</span>{urls.old ? <img src={urls.old} className="max-h-[420px] max-w-full mx-auto object-contain" alt={`Before ${file.path}`} /> : <div className="h-full flex items-center justify-center text-muted text-[11px]">Not present</div>}</div>
      <div className="p-4 min-h-28 relative"><span className="absolute top-1 left-2 text-[10px] text-muted bg-surface-0/80 px-1 rounded">After</span>{urls.new ? <img src={urls.new} className="max-h-[420px] max-w-full mx-auto object-contain" alt={`After ${file.path}`} /> : <div className="h-full flex items-center justify-center text-muted text-[11px]">Not present</div>}</div>
    </div>
  )
}

type AgentAction = { kind: 'review' | 'changes' }

export default function GitReviewView({ workspaceId, panelId, snapshot, send }: {
  workspaceId: string
  panelId: string
  snapshot: ReviewSnapshot
  send: ReviewSend
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const { review, comparison, loading, busy, agentBusy, error, notRepository, branches, commits } = snapshot
  const view = useReviewView(workspaceId, panelId, snapshot)
  const { display, collapsed, focusedFile, fileFilter } = view
  const { diffs, errors, load, reload } = useReviewDiffs(send, snapshot, display.fullFile, view.diffOptions)
  const picker = useAgentPicker(send)
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null)
  const [agentAction, setAgentAction] = useState<AgentAction | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const agentPopoverRef = useRef<HTMLDivElement>(null)
  const ui = clientUi()
  const comparisonKey = JSON.stringify([review.repoPath, review.spec])

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
    if (!focusedFile || !comparison) return
    requestAnimationFrame(() => {
      panelRef.current?.querySelector(`[data-review-file="${encodeURIComponent(focusedFile)}"]`)?.scrollIntoView({ block: 'start' })
    })
  }, [focusedFile, comparison])

  const openPicker = (kind: AgentAction['kind']) => {
    setAgentAction({ kind })
    picker.show()
  }
  const togglePicker = (kind: AgentAction['kind']) => (agentAction?.kind === kind ? setAgentAction(null) : openPicker(kind))
  const reviewWithAgent = async (agentId: AgentId) => {
    const place = await pickReviewTerminal(workspaceId, panelId)
    if (place && await send({ kind: 'reviewWithAgent', agentId, ...place })) setAgentAction(null)
  }
  const requestChanges = async (agentId?: AgentId) => {
    // The source agent's own terminal needs no choice; a new agent does.
    const place = agentId ? await pickReviewTerminal(workspaceId, panelId) : {}
    if (!place) return
    const outcome = await send({ kind: 'requestChanges', agentId, ...place })
    if (outcome === 'done') setAgentAction(null)
    else if (outcome === 'pick-agent') openPicker('changes')
  }
  const discardFile = (file: GitChangedFile) => {
    const message = file.untracked
      ? `Move untracked file "${file.path}" to the trash?`
      : `Discard working changes in "${file.path}"? Staged changes will be preserved.`
    void ui.confirm(message).then((confirmed) => {
      if (confirmed) void send({ kind: 'discard', path: file.path, untracked: !!file.untracked })
    })
  }
  const openFile = (file: GitChangedFile) => {
    const store = documentStoreFor(workspaceId)
    if (!store) return
    const doc = store.getSnapshot()
    const filePath = joinPath(review.repoPath, file.path)
    const record = freshRecord(doc, 'editor', { filePath, title: file.path.split('/').pop() })
    if (record && store.propose({ kind: 'addPanel', record, at: placeNear(doc, panelId) }).ok) revealPanel(workspaceId, record.id)
  }
  const copyApplyCommand = async () => {
    const command = await sendOrShow(send, { kind: 'applyCommand' }, 'Could not copy patch')
    if (typeof command === 'string') await ui.writeClipboard?.(command)
  }
  const saveNotes = async () => {
    const target = await ui.pickSavePath({ workspaceId, defaultPath: joinPath(review.repoPath, 'review-notes.md'), rootPath: review.repoPath, title: 'Save Review Notes' })
    if (target) await sendOrShow(send, { kind: 'saveNotes', path: target }, 'Could not save review notes')
  }
  const createPullRequest = async () => {
    const result = await send({ kind: 'createPullRequest' }) as { url: string } | null
    if (result?.url) ui.openExternal(result.url)
  }

  const filteredFiles = useMemo(() => {
    const query = fileFilter.trim().toLowerCase()
    return comparison?.files.filter((file) => !query || file.path.toLowerCase().includes(query) || file.oldPath?.toLowerCase().includes(query)) ?? []
  }, [comparison, fileFilter])
  const allCollapsed = filteredFiles.length > 0 && filteredFiles.every((file) => collapsed.has(file.path))
  const workingMode = review.spec.kind === 'uncommitted' || review.spec.kind === 'unstaged'
  const stagedMode = review.spec.kind === 'staged'
  const currentBranchMode = review.spec.kind === 'branch' && review.spec.target === comparison?.currentBranch
  const openNotes = openFindings(review.notes).filter((note) => note.side !== 'file')
  const hasNotes = (review.notes?.length ?? 0) > 0
  const agentReview = review.agentReview
  const spec = review.spec
  return (
    <div ref={panelRef} className="relative flex flex-col w-full min-w-0 h-full min-h-0 bg-surface-0 text-primary">
      <ReviewToolbar review={review} busy={busy} send={send}>
        {spec.kind === 'commit' && (
          <SearchableRefInput
            id={`review-commit-${panelId}`}
            value={spec.commit}
            options={commits.map((item) => ({ value: item.hash, label: item.message }))}
            onCommit={(commit) => void send({ kind: 'setSpec', spec: { kind: 'commit', commit, ignoreWhitespace: spec.ignoreWhitespace } })}
            ariaLabel="Search commits"
            className="review-ref h-7 min-w-0 max-w-[300px] rounded-lg bg-surface-2 border border-subtle px-2 text-[11px] font-mono focus:outline-none"
          />
        )}
        {spec.kind === 'branch' && (
          <>
            <SearchableRefInput
              id={`review-base-${panelId}`}
              value={spec.base}
              options={branches.map((branch) => ({ value: branch.name }))}
              onCommit={(base) => void send({ kind: 'setSpec', spec: { ...spec, base } })}
              ariaLabel="Search base branches"
              className="review-ref h-7 min-w-0 max-w-[180px] rounded-lg bg-surface-2 border border-subtle px-2 text-[11px] focus:outline-none"
            />
            <span className="text-muted">→</span>
            <SearchableRefInput
              id={`review-target-${panelId}`}
              value={spec.target}
              options={branches.map((branch) => ({ value: branch.name }))}
              onCommit={(target) => void send({ kind: 'setSpec', spec: { ...spec, target } })}
              ariaLabel="Search target branches"
              className="review-ref h-7 min-w-0 max-w-[180px] rounded-lg bg-surface-2 border border-subtle px-2 text-[11px] focus:outline-none"
            />
          </>
        )}
        <div className="review-toolbar-actions flex shrink-0 items-center gap-1 ml-auto">
          <ReviewRunStatus review={agentReview} />
          <ReviewStats files={comparison?.files.length ?? 0} additions={comparison?.additions ?? 0} deletions={comparison?.deletions ?? 0} />
          <ToolbarButton label="Refresh" onClick={() => void send({ kind: 'refresh' })} disabled={loading}>{loading ? <Spinner size={14} label="Refreshing changes" /> : <ArrowClockwise size={14} />}</ToolbarButton>
          <div ref={agentAction?.kind === 'review' ? agentPopoverRef : undefined} className="relative">
            <ReviewActionButton label="Review in terminal" onClick={() => togglePicker('review')} disabled={agentBusy || agentReview?.status === 'working'} />
            {agentAction?.kind === 'review' && (
              <AgentPickerPopover
                action={agentAction}
                choices={picker.choices}
                selectedAgentId={picker.selected}
                busy={agentBusy}
                onSelect={picker.select}
                onClose={() => !agentBusy && setAgentAction(null)}
                onConfirm={() => picker.selected && void reviewWithAgent(picker.selected)}
              />
            )}
          </div>
          <div ref={agentAction?.kind === 'changes' ? agentPopoverRef : undefined} className="relative">
            <ReviewActionButton
              label={`Request changes${openNotes.length ? ` (${openNotes.length})` : ''}`}
              title={openNotes.length === 0 ? 'Add an open review note before requesting changes' : 'Send open findings to an agent'}
              onClick={() => (review.sourceAgent ? void requestChanges() : togglePicker('changes'))}
              disabled={agentBusy || openNotes.length === 0}
            >
              <PaperPlaneTilt size={14} />
            </ReviewActionButton>
            {agentAction?.kind === 'changes' && (
              <AgentPickerPopover
                action={agentAction}
                choices={picker.choices}
                selectedAgentId={picker.selected}
                busy={agentBusy}
                onSelect={picker.select}
                onClose={() => !agentBusy && setAgentAction(null)}
                onConfirm={() => picker.selected && void requestChanges(picker.selected)}
              />
            )}
          </div>
          <ToolbarButton label={display.split ? 'Switch to unified diff' : 'Switch to split diff'} onClick={() => view.updateDisplay({ split: !display.split })}>
            {display.split ? <Rows size={14} /> : <SplitHorizontal size={14} />}
          </ToolbarButton>
          {currentBranchMode && (
            <ToolbarButton label="Create pull request" disabled={busy} onClick={() => void createPullRequest()}>
              <GitPullRequest size={14} />
            </ToolbarButton>
          )}
          <div ref={moreMenuRef} className="relative">
            <ToolbarButton label="More review options" active={moreOpen} onClick={() => setMoreOpen((open) => !open)}><DotsThree size={16} /></ToolbarButton>
            {moreOpen && (
              <div role="menu" className={`absolute right-0 top-8 z-50 w-56 ${POPOVER_SURFACE} p-1.5`}>
                <ReviewDisplayOptions display={display} update={view.updateDisplay} />
                <ReviewMenuButton label="Load full files" active={display.fullFile} onClick={() => view.updateDisplay({ fullFile: !display.fullFile })}><File size={14} /></ReviewMenuButton>
                <ReviewMenuButton label="Image previews" active={display.advancedPreview} onClick={() => view.updateDisplay({ advancedPreview: !display.advancedPreview })}><ImageSquare size={14} /></ReviewMenuButton>
                <ReviewMenuButton label="Ignore whitespace" active={!!spec.ignoreWhitespace} onClick={() => void send({ kind: 'setSpec', spec: { ...spec, ignoreWhitespace: !spec.ignoreWhitespace } })}><Check size={14} /></ReviewMenuButton>
                <div className="my-1 border-t border-subtle" />
                {ui.writeClipboard && <ReviewMenuButton label="Copy git apply command" onClick={() => { setMoreOpen(false); void copyApplyCommand() }} disabled={!comparison || busy}><Code size={14} /></ReviewMenuButton>}
                {ui.writeClipboard && <ReviewMenuButton label="Copy review notes" onClick={() => { setMoreOpen(false); void ui.writeClipboard?.(notesMarkdown(review.notes ?? [])) }} disabled={!hasNotes}><ClipboardText size={14} /></ReviewMenuButton>}
                <ReviewMenuButton label="Save review notes" onClick={() => { setMoreOpen(false); void saveNotes() }} disabled={!hasNotes}><NotePencil size={14} /></ReviewMenuButton>
              </div>
            )}
          </div>
        </div>
      </ReviewToolbar>

      <ReviewFileFilter
        value={fileFilter}
        onChange={view.setFileFilter}
        allCollapsed={allCollapsed}
        disabled={filteredFiles.length === 0}
        onToggleCollapsed={() => view.setCollapsed(allCollapsed ? [] : filteredFiles.map((file) => file.path))}
      />

      {error && <div className="px-3 py-2 bg-red-500/10 text-red-400 text-[11px] border-b border-red-500/15">{error}</div>}

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {!loading && !error && notRepository && (
          <div data-review-not-repository className="h-full flex flex-col items-center justify-center gap-2 text-muted text-[12px]"><GitDiff size={28} /><span>This folder is not a Git repository</span></div>
        )}
        {!loading && !error && !notRepository && filteredFiles.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-muted text-[12px]"><GitDiff size={28} /><span>No changes in this comparison</span></div>
        )}
        {filteredFiles.map((file) => {
          const isCollapsed = collapsed.has(file.path)
          const fileNotes = (review.notes ?? []).filter((note) => note.path === file.path && note.side !== 'file')
          const fileDraft = noteDraft?.filePath === file.path ? noteDraft : null
          const fullFile = display.fullFile || view.isExpanded(file.path)
          return (
            <section key={file.path} data-review-file={encodeURIComponent(file.path)} className="min-w-0 border-b border-subtle scroll-mt-2">
              <div className="sticky top-0 z-10 flex items-center gap-2 px-2 py-1.5 bg-surface-2/95 backdrop-blur border-b border-subtle group">
                <button aria-label={isCollapsed ? 'Expand file' : 'Collapse file'} onClick={() => view.toggleCollapsed(file.path)} className="text-muted hover:text-primary">{isCollapsed ? <CaretRight size={13} /> : <CaretDown size={13} />}</button>
                <span className={`w-4 text-center font-mono text-[11px] ${statusClass(file)}`}>{statusLabel(file)}</span>
                <span className="font-mono text-[11px] truncate flex-1" title={file.path}>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
                <span className="text-[10px] tabular-nums"><span className="text-diff-add">+{file.additions ?? '–'}</span> <span className="text-diff-del">-{file.deletions ?? '–'}</span></span>
                {fileNotes.length > 0 && <span className="text-[10px] text-blue-400">{fileNotes.length} note{fileNotes.length === 1 ? '' : 's'}</span>}
                <ToolbarButton label="Open file" onClick={() => openFile(file)}><FileMagnifyingGlass size={13} /></ToolbarButton>
                {workingMode && file.working && <ToolbarButton label="Stage file" disabled={busy} onClick={() => void send({ kind: 'stage', path: file.path })}><Plus size={13} /></ToolbarButton>}
                {(stagedMode || (spec.kind === 'uncommitted' && file.staged)) && <ToolbarButton label="Unstage file" disabled={busy} onClick={() => void send({ kind: 'unstage', path: file.path })}><Minus size={13} /></ToolbarButton>}
                {workingMode && file.working && <ToolbarButton label="Discard working changes" disabled={busy} onClick={() => discardFile(file)}><Trash size={13} /></ToolbarButton>}
              </div>
              {!isCollapsed && display.advancedPreview && imageMime(file.path)
                ? <ImageComparisonPreview send={send} file={file} comparisonKey={`${comparisonKey}:${snapshot.diffEpoch}`} />
                : !isCollapsed && (
                  <div className="max-w-full overflow-x-auto overscroll-x-contain [container-type:inline-size]">
                    <LazyDiffBody
                      diff={diffs[file.path]}
                      error={errors[file.path]}
                      load={() => load(file.path)}
                      allowLarge={() => reload(file.path, { kind: 'diff', path: file.path, options: { ...view.diffOptions(file.path), allowLarge: true } })}
                      split={display.split}
                      wordDiff={display.wordDiff}
                      wrap={display.wrap}
                      notes={fileNotes}
                      addNote={(side, line, context) => setNoteDraft({ filePath: file.path, side, line, context })}
                      toggleNote={(noteId) => void send({ kind: 'toggleNote', noteId })}
                      noteDraft={fileDraft}
                      submitNote={(body, severity) => {
                        if (!fileDraft) return
                        void send({ kind: 'addNote', note: { path: fileDraft.filePath, side: fileDraft.side, line: fileDraft.line, context: fileDraft.context, body, severity } })
                        setNoteDraft(null)
                      }}
                      cancelNote={() => setNoteDraft(null)}
                      fullFile={fullFile}
                      expandContext={() => reload(file.path, { kind: 'diff', path: file.path, options: view.expandContext(file.path) })}
                      expandFullFile={() => reload(file.path, { kind: 'diff', path: file.path, options: view.expandFullFile(file.path) })}
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
