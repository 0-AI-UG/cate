import React, { useEffect, useRef, useState } from 'react'
import { RotateCw as ArrowClockwise, ChevronDown as CaretDown, ChevronRight as CaretRight, Ellipsis as DotsThree, Funnel, Info, Rows2 as Rows, Split as SplitHorizontal, X } from 'lucide-react'
import { LoadingState, POPOVER_SURFACE, PopoverSurface, Spinner, useDismissableLayer, useViewportPopoverPosition } from '@kernel/ui'
import { useDocument } from '@client/document/ui'
import { panelDefinition } from '@client/host'
import { AGENTS, agentDisplayName, type AgentChangedFile, type AgentChangesFilter } from '@services/agents/contract'
import type { PanelRecord } from '@workspace/document/contract'
import type { AgentChangesFilterPatch, RecordedFileSummary, ReviewDisplay, ReviewNote, ReviewNoteSeverity, ReviewSnapshot } from '../contract'
import { revealPanel } from '../parts/view/openReview'
import { pickReviewTerminal } from '../parts/view/pickTerminal'
import { ReviewToolbar } from './ReviewToolbar'
import { AgentPickerPopover, ReviewActionButton, ReviewDisplayOptions, ReviewFileFilter, ReviewRunStatus, ReviewStats, ToolbarButton } from './ReviewControls'
import { RecordedDiffHunk, type NoteDraft } from './ReviewDiff'
import { useAgentPicker, useReviewView, type ReviewSend } from './useReview'

type RecordedDraft = NoteDraft & { agentChangeId: string }

/** Panels that run agents: the ones taking prompts. */
const isAgentPanel = (panel: PanelRecord) => panelDefinition(panel.type)?.relation?.execution === true
const sameRecords = (a: PanelRecord[], b: PanelRecord[]) => a.length === b.length && a.every((item, index) => item === b[index])

function RecordedReviewButton({ workspaceId, panelId, send, disabled, busy }: {
  workspaceId: string
  panelId: string
  send: ReviewSend
  disabled: boolean
  busy: boolean
}) {
  const picker = useAgentPicker(send)
  const content = useRef<HTMLDivElement>(null)
  useDismissableLayer({ open: picker.open && !busy, contentRef: content, onDismiss: picker.close })
  const launch = async () => {
    if (!picker.selected) return
    const place = await pickReviewTerminal(workspaceId, panelId)
    if (place && await send({ kind: 'reviewWithAgent', agentId: picker.selected, ...place })) picker.close()
  }
  return <div ref={content} className="relative">
    <ReviewActionButton label="Review in terminal" disabled={disabled || busy} onClick={() => (picker.open ? picker.close() : picker.show())} />
    {picker.open && <AgentPickerPopover action={{ kind: 'review' }} choices={picker.choices} selectedAgentId={picker.selected} busy={busy} onSelect={picker.select} onClose={() => !busy && picker.close()} onConfirm={() => void launch()} />}
  </div>
}

export default function AgentChangesView({ workspaceId, panelId, snapshot, send }: {
  workspaceId: string
  panelId: string
  snapshot: ReviewSnapshot
  send: ReviewSend
}) {
  const { review, recorded, loading: refreshing, agentBusy, busy, error: sessionError } = snapshot
  const panels = useDocument(workspaceId, (doc) => Object.values(doc.panels).filter(isAgentPanel), sameRecords)
  const filter = review.agentChanges ?? {}
  const loading = recorded.loading || refreshing
  const error = sessionError ?? recorded.error
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const morePopover = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [noteDraft, setNoteDraft] = useState<RecordedDraft | null>(null)
  const [visibleCount, setVisibleCount] = useState(50)
  const showHistory = !!review.showHistory
  useDismissableLayer({ open: moreOpen, contentRef: morePopover, onDismiss: () => setMoreOpen(false) })
  const { pos, portalTarget } = useViewportPopoverPosition(trigger, open, (rect) => ({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 264)), gap: 6, height: 180 }), popover)
  useDismissableLayer({ open, contentRef: popover, triggerRefs: [trigger], onDismiss: () => setOpen(false) })
  const positioned = !!pos
  useEffect(() => { if (open && positioned) popover.current?.querySelector('select')?.focus() }, [open, positioned])

  const update = (patch: AgentChangesFilterPatch) => void send({ kind: 'updateFilter', patch })
  const view = useReviewView(workspaceId, panelId, review.focusedFile)
  const { display, collapsed, updateDisplay } = view
  const files = recorded.files
  const panelChoices = new Map(panels.map((panel) => [panel.id, panel.title]))
  for (const file of files) for (const id of file.panelIds) if (!panelChoices.has(id)) panelChoices.set(id, `Closed panel ${panelChoices.size + 1}`)
  if (filter.panelId && !panelChoices.has(filter.panelId)) panelChoices.set(filter.panelId, 'Source panel (closed)')
  const focusedIndex = review.focusedFile ? files.findIndex((file) => file.path === review.focusedFile) : -1
  const shownCount = Math.max(visibleCount, focusedIndex + 1)
  const totals = files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 })
  const keyOf = (file: RecordedFileSummary) => `${file.recordId}:${file.path}`
  const allCollapsed = files.length > 0 && files.every((file) => collapsed.has(keyOf(file)))
  const byId = new Map(panels.map((panel) => [panel.id, panel]))
  useEffect(() => {
    if (!review.focusedFile) return
    root.current?.querySelector(`[data-review-file="${encodeURIComponent(review.focusedFile)}"]`)?.scrollIntoView?.({ block: 'start' })
  }, [review.focusedFile, files, shownCount])
  const chips = [
    filter.agentId && { label: agentDisplayName(filter.agentId), patch: { agentId: null } },
    filter.panelId && { label: panelChoices.get(filter.panelId)!, patch: { panelId: null, sessionId: null, turnId: null } },
    filter.sessionId && { label: 'This conversation', patch: { sessionId: null, turnId: null } },
    filter.turnId && { label: 'This turn', patch: { turnId: null } },
  ].filter(Boolean) as { label: string; patch: AgentChangesFilterPatch }[]
  const selectClass = 'h-7 w-full rounded-lg bg-surface-2 border border-subtle px-2 text-xs'
  const addNote = (draft: RecordedDraft, body: string, severity: ReviewNoteSeverity) => {
    void send({ kind: 'addNote', note: { agentChangeId: draft.agentChangeId, path: draft.filePath, side: draft.side, line: draft.line, context: draft.context, body, severity } })
    setNoteDraft(null)
  }
  return <div className="flex w-full min-w-0 h-full min-h-0 flex-col bg-surface-0 text-primary">
    <ReviewToolbar workspaceId={workspaceId} review={review} busy={busy} send={send}>
      <button ref={trigger} aria-label="Filters" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} title="Filters" className="review-action flex h-7 shrink-0 items-center justify-center gap-1 rounded-lg px-2 text-xs hover:bg-surface-2"><Funnel size={14} /><span className="review-action-label">Filters</span></button>
      <div className="review-toolbar-actions ml-auto flex shrink-0 items-center gap-1">
        <ReviewRunStatus review={review.agentReview} />
        <ReviewStats files={new Set(files.map((file) => file.path)).size} additions={totals.additions} deletions={totals.deletions} />
        <ToolbarButton label="Refresh" disabled={loading} onClick={() => void send({ kind: 'refresh' })}>{loading ? <Spinner size={14} label="Refreshing changes" /> : <ArrowClockwise size={14} />}</ToolbarButton>
        <RecordedReviewButton workspaceId={workspaceId} panelId={panelId} send={send} busy={agentBusy} disabled={!files.length || review.agentReview?.status === 'working'} />
        <ToolbarButton label={display.split ? 'Switch to unified diff' : 'Switch to split diff'} onClick={() => updateDisplay({ split: !display.split })}>{display.split ? <Rows size={14} /> : <SplitHorizontal size={14} />}</ToolbarButton>
        <div ref={morePopover} className="relative">
          <ToolbarButton label="More review options" active={moreOpen} onClick={() => setMoreOpen(!moreOpen)}><DotsThree size={16} /></ToolbarButton>
          {moreOpen && <div role="menu" className={`absolute right-0 top-8 z-50 w-56 ${POPOVER_SURFACE} p-1.5`}>
            <button role="menuitem" aria-pressed={showHistory} onClick={() => void send({ kind: 'update', patch: { showHistory: !showHistory } })} className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-hover">{showHistory ? 'Show active changes' : 'Show recorded history'}</button>
            <div className="my-1 border-t border-subtle" />
            <ReviewDisplayOptions display={display} update={updateDisplay} />
          </div>}
        </div>
        <span className="text-muted" title={showHistory ? 'Historical recorded agent edits. Shell-generated or unreported edits may be missing.' : 'Recorded agent edits limited to files with current staged or unstaged Git changes. Shell-generated or unreported edits may be missing.'}><Info size={14} aria-label="About recorded edits" /></span>
      </div>
    </ReviewToolbar>
    {chips.length > 0 && <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-subtle px-2 py-1.5">{chips.map((chip, index) => <button key={index} aria-label={`Remove ${chip.label} filter`} onClick={() => update(chip.patch)} className="flex h-6 max-w-48 items-center gap-1 rounded-md border border-subtle bg-surface-2 px-1.5 text-[11px]"><span className="truncate">{chip.label}</span><X size={10} className="shrink-0" /></button>)}</div>}
    {open && <PopoverSurface popoverRef={popover} pos={pos} portalTarget={portalTarget} width={256} className="p-3 text-primary">
      <div role="dialog" aria-label="Change filters" className="space-y-3">
        <label className="block text-xs">Agent
          <select aria-label="Filter by agent" value={filter.agentId ?? ''} className={selectClass}
            onChange={(event) => update({ agentId: (event.target.value || null) as AgentChangesFilter['agentId'] | null, sessionId: null, turnId: null })}>
            <option value="">All agents</option>{AGENTS.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}
          </select>
        </label>
        <label className="block text-xs">Panel
          <select aria-label="Filter by panel" value={filter.panelId ?? ''} className={selectClass}
            onChange={(event) => update({ panelId: event.target.value || null, sessionId: null, turnId: null })}>
            <option value="">All panels</option>{[...panelChoices].map(([id, title]) => <option key={id} value={id}>{title}</option>)}
          </select>
        </label>
        <div className="flex justify-between text-xs"><button onClick={() => update({ agentId: null, panelId: null, sessionId: null, turnId: null })}>Clear filters</button><button onClick={() => { setOpen(false); trigger.current?.focus() }}>Done</button></div>
      </div>
    </PopoverSurface>}
    <ReviewFileFilter value={review.fileFilter ?? ''} onChange={(fileFilter) => void send({ kind: 'update', patch: { fileFilter } })} allCollapsed={allCollapsed} disabled={!files.length} onToggleCollapsed={() => view.setCollapsed(allCollapsed ? [] : files.map(keyOf))} />
    {error && <p role="alert" className="px-3 py-2 text-xs text-red-400">{error}</p>}
    <div ref={root} className="min-h-0 flex-1 overflow-auto">
      {loading && <LoadingState label="Loading recorded changes" className="h-full p-4 text-xs" />}
      {!loading && !files.length && <p className="p-4 text-xs text-muted">{showHistory ? 'No recorded edits match these filters. This does not mean the agent made no changes.' : 'No active agent edits match these filters. Recorded history is still available from the review options.'}</p>}
      {files.slice(0, shownCount).map((file) => {
        const key = keyOf(file)
        const agent = agentDisplayName(file.agentId)
        const sourcePanels = file.panelIds.map((id) => byId.get(id)).filter((panel): panel is PanelRecord => !!panel)
        return <section key={key} data-review-file={encodeURIComponent(file.path)} className="min-w-0 border-b border-subtle scroll-mt-2">
          <div className="sticky top-0 z-10 flex w-full items-center gap-2 border-b border-subtle bg-surface-2/95 px-2 py-1.5 backdrop-blur">
            <button aria-expanded={!collapsed.has(key)} onClick={() => view.toggleCollapsed(key)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
              {collapsed.has(key) ? <CaretRight size={12} /> : <CaretDown size={12} />}
              <span title={agent} className="w-4 h-4 shrink-0 rounded bg-surface-4 flex items-center justify-center text-[9px]">{agent[0]}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{file.oldPath ? `${file.oldPath} → ` : ''}{file.path}</span>
            </button>
            {sourcePanels.map((panel) => <button key={panel.id} aria-label={`Go to ${panel.title}`} title={`Go to ${panel.title}`} onClick={() => revealPanel(workspaceId, panel.id)} className="inline-flex min-w-0 max-w-40 items-center gap-1 rounded-full border border-subtle bg-surface-3 px-2 py-0.5 text-[10px] text-secondary hover:bg-hover hover:text-primary"><span className="truncate">{panel.title}</span></button>)}
            {sourcePanels.length === 0 && <span className="text-[10px] text-muted" title="The source panel is no longer available">Panel closed</span>}
            <span className="text-[10px] tabular-nums text-diff-add">+{file.additions}</span><span className="text-[10px] tabular-nums text-diff-del">−{file.deletions}</span>
            {file.coverage === 'fragment' && <span title="Reported edit fragment; full-file context and line numbers are unavailable." className="text-muted"><Info size={12} /></span>}
          </div>
          {!collapsed.has(key) && <RecordedFileBody
            send={send}
            file={file}
            display={display}
            notes={(review.notes ?? []).filter((note) => note.path === file.path && note.agentChangeId === file.recordId)}
            noteDraft={noteDraft?.filePath === file.path && noteDraft.agentChangeId === file.recordId ? noteDraft : null}
            setNoteDraft={setNoteDraft}
            addNote={addNote}
            toggleNote={(noteId) => void send({ kind: 'toggleNote', noteId })}
          />}
        </section>
      })}
      {shownCount < files.length && <button className="m-3 rounded bg-surface-2 px-3 py-2 text-xs" onClick={() => setVisibleCount(shownCount + 50)}>Show more recorded files ({files.length - shownCount} remaining)</button>}
    </div>
  </div>
}

/** A recorded file's hunks, fetched from the session once visible. */
function RecordedFileBody({ send, file, display, notes, noteDraft, setNoteDraft, addNote, toggleNote }: {
  send: ReviewSend
  file: RecordedFileSummary
  display: Pick<ReviewDisplay, 'split' | 'wordDiff' | 'wrap'>
  notes: ReviewNote[]
  noteDraft: RecordedDraft | null
  setNoteDraft: React.Dispatch<React.SetStateAction<RecordedDraft | null>>
  addNote: (draft: RecordedDraft, body: string, severity: ReviewNoteSeverity) => void
  toggleNote: (noteId: string) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined')
  const [allowLarge, setAllowLarge] = useState(false)
  const [body, setBody] = useState<AgentChangedFile | null>(null)
  const [failed, setFailed] = useState(false)
  const large = file.lineCount > 5000
  useEffect(() => {
    if (visible || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '600px' })
    if (root.current) observer.observe(root.current)
    return () => observer.disconnect()
  }, [visible])
  useEffect(() => {
    if (!visible || (large && !allowLarge)) return
    let live = true
    send({ kind: 'recordedDiff', recordId: file.recordId, path: file.path }).then(
      (result) => { if (live) setBody(result as AgentChangedFile) },
      () => { if (live) setFailed(true) },
    )
    return () => { live = false }
  }, [send, visible, large, allowLarge, file.recordId, file.path])
  return <div ref={root} className={`font-mono text-[11px] leading-[1.45] ${display.wrap ? 'w-full min-w-0 whitespace-pre-wrap break-all' : 'w-max min-w-full whitespace-pre'}`}>
    {large && !allowLarge ? <button className="m-3 rounded bg-surface-2 px-3 py-2" onClick={() => setAllowLarge(true)}>Load large recorded diff</button>
      : failed ? <p className="px-3 py-2 text-red-400">Could not load this recorded edit.</p>
      : !body ? <LoadingState label="Loading recorded diff" className="h-20" />
      : <>
        {file.coverage === 'unavailable' && <p className="px-3 py-2 text-muted">No patch was reported for this file.</p>}
        {body.hunks.map((hunk, index) => <RecordedDiffHunk
          key={index}
          split={display.split}
          wordDiff={display.wordDiff}
          wrap={display.wrap}
          hunk={file.coverage === 'fragment' ? { ...hunk, lines: hunk.lines.map((line) => ({ ...line, oldLine: null, newLine: null })) } : hunk}
          notes={notes}
          addNote={(side, line, context) => setNoteDraft({ agentChangeId: file.recordId, filePath: file.path, side, line, context })}
          toggleNote={toggleNote}
          noteDraft={noteDraft}
          submitNote={(text, severity) => noteDraft && addNote(noteDraft, text, severity)}
          cancelNote={() => setNoteDraft(null)}
        />)}
      </>}
  </div>
}
