import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown as CaretDown, ChevronRight as CaretRight, Ellipsis as DotsThree, GitCompareArrows, GitCommitHorizontal, Info, Search, X } from 'lucide-react'
import { LoadingState, Pagination } from '../../kernel/interaction'
import { clientUi, errorMessage } from '@kernel/interaction'
import { useDocument } from '../../client/document'
import { agentDisplayName, type AgentId } from '@services/agents/contract'
import type { PanelRecord } from '@workspace/document/contract'
import type { AgentChangesFilterPatch, RecordedDiffPage, RecordedFileSummary, ReviewDisplay, ReviewSnapshot } from '@panels/review/contract'
import { revealPanel } from '@client/host'
import { PanelTitle, usePanelTitles } from '../../client/host'
import { pickReviewTerminal } from './parts/pickTerminal'
import { ReviewToolbar } from './ReviewToolbar'
import { ReviewFilters } from './ReviewFilters'
import { ReviewAgentButton, ReviewFileFilter, ReviewStats, ToolbarButton } from './ReviewControls'
import { agentLogo } from '../../services/agents'
import { GitDiff } from '../../workspace/repository'
import { recordedGroupKey, useAgentPicker, useReviewView, type ReviewSend } from './useReview'


const sameRecords = (a: PanelRecord[], b: PanelRecord[]) => a.length === b.length && a.every((item, index) => item === b[index])

function RecordedReviewButton({ workspaceId, panelId, send, disabled, busy }: {
  workspaceId: string
  panelId: string
  send: ReviewSend
  disabled: boolean
  busy: boolean
}) {
  const picker = useAgentPicker(workspaceId)
  const [starting, setStarting] = useState(false)
  const launch = async (agentId: AgentId) => {
    const place = await pickReviewTerminal(workspaceId, panelId)
    if (!place) return
    setStarting(true)
    try { if (await send({ kind: 'reviewWithAgent', agentId, ...place })) picker.close() }
    catch (cause) { clientUi().showError(errorMessage(cause, 'Could not start review')) }
    finally { setStarting(false) }
  }
  return <ReviewAgentButton
    label="Review in terminal"
    disabled={disabled || busy || starting}
    busy={busy || starting}
    open={picker.open}
    choices={picker.choices}
    onOpenChange={(open) => (open ? picker.show() : picker.close())}
    onPick={(agentId) => void launch(agentId)}
  />
}

export default function AgentChangesView({ workspaceId, panelId, snapshot, send }: {
  workspaceId: string
  panelId: string
  snapshot: ReviewSnapshot
  send: ReviewSend
}) {
  const { review, recorded, loading: refreshing, agentBusy, error: sessionError } = snapshot
  const titles = usePanelTitles(workspaceId)
  const panels = useDocument(workspaceId, (doc) => Object.values(doc.panels), sameRecords)
  const filter = review.agentChanges ?? {}
  const [pending, setPending] = useState(false)
  const loading = recorded.loading || refreshing || pending
  const error = sessionError ?? recorded.error
  const root = useRef<HTMLDivElement>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const update = async (patch: AgentChangesFilterPatch) => {
    setPending(true)
    try { await send({ kind: 'updateFilter', patch }) }
    catch (cause) { clientUi().showError(errorMessage(cause, 'Could not filter agent changes')) }
    finally { setPending(false) }
  }
  const view = useReviewView(workspaceId, panelId, snapshot)
  const { display, expanded, collapsedGroups, updateDisplay, focusedFile, fileFilter } = view
  const query = fileFilter.trim().toLowerCase()
  const files = useMemo(() => query ? recorded.files.filter((file) => file.path.toLowerCase().includes(query)) : recorded.files, [recorded.files, query])
  const sources = recorded.panels
  const agents = recorded.agents
  const panelChoices = new Map(sources.map((source) => [source.id, source.title]))
  for (const panel of panels) panelChoices.set(panel.id, panel.title)
  const groups = useMemo(() => {
    const groups = new Map<string, RecordedFileSummary[]>()
    for (const file of files) {
      const key = recordedGroupKey(file, view.grouping)
      const group = groups.get(key)
      if (group) group.push(file)
      else groups.set(key, [file])
    }
    const entries = [...groups.entries()]
    return view.grouping === 'pullRequest' ? entries.sort((a, b) => (a[1][0].prNumber ?? Infinity) - (b[1][0].prNumber ?? Infinity)) : entries
  }, [files, view.grouping])
  const totals = files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 })
  const keyOf = (file: RecordedFileSummary) => `${file.recordId}:${file.path}`
  const byId = new Map(panels.map((panel) => [panel.id, panel]))
  useEffect(() => {
    if (focusedFile) root.current?.querySelector(`[data-review-file="${encodeURIComponent(focusedFile)}"]`)?.scrollIntoView?.({ block: 'start' })
  }, [focusedFile, view.revealSeq])
  const showOptions = async () => {
    if (moreOpen) return
    setMoreOpen(true)
    try {
      const choice = await clientUi().showContextMenu([
        { id: 'split', label: 'Side-by-side diff', type: 'checkbox', checked: display.split },
        { id: 'wordDiff', label: 'Word differences', type: 'checkbox', checked: display.wordDiff },
        { id: 'wrap', label: 'Wrap lines', type: 'checkbox', checked: display.wrap },
        { type: 'separator' },
        { id: 'collapse', label: 'Collapse all files', enabled: expanded.size > 0 },
      ])
      if (choice === 'collapse') view.collapseAll()
      else if (choice === 'split' || choice === 'wordDiff' || choice === 'wrap') updateDisplay({ [choice]: !display[choice] })
    } finally { setMoreOpen(false) }
  }
  const chips = [
    filter.sessionId && { label: 'This conversation', patch: { sessionId: null, turnId: null } },
    filter.turnId && { label: 'This turn', patch: { turnId: null } },
  ].filter(Boolean) as { label: string; patch: AgentChangesFilterPatch }[]
  return <div className="flex w-full min-w-0 h-full min-h-0 flex-col overflow-hidden bg-surface-0 text-primary">
    <ReviewToolbar review={review} busy={loading} send={send}>
      <ReviewFilters titles={titles} workspaceId={workspaceId} panelId={panelId} filter={filter} panels={panels} sources={sources} agents={agents} disabled={loading} update={(patch) => { void update(patch) }} />
      <select aria-label="Group recorded edits" value={view.grouping} onChange={(event) => view.setGrouping(event.target.value as typeof view.grouping)} className="min-w-0 rounded border border-subtle bg-surface-1 px-1 py-1 text-xs text-secondary">
        <option value="commit">Commits</option><option value="pullRequest">Pull requests</option><option value="conversation">Conversations</option>
      </select>
      <div className="review-toolbar-actions ml-auto flex shrink-0 items-center gap-1">
        {!loading && <ReviewStats files={new Set(files.map((file) => file.path)).size} additions={totals.additions} deletions={totals.deletions} />}
        <RecordedReviewButton workspaceId={workspaceId} panelId={panelId} send={send} busy={agentBusy} disabled={!recorded.files.length} />
        <ToolbarButton label="Filter changed files" active={searchOpen || !!fileFilter} onClick={() => { if (searchOpen || fileFilter) { view.setFileFilter(''); setSearchOpen(false) } else setSearchOpen(true) }}><Search size={14} /></ToolbarButton>
        <ToolbarButton label="More review options" active={moreOpen} onClick={() => void showOptions()}><DotsThree size={16} /></ToolbarButton>
      </div>
    </ReviewToolbar>
    {chips.length > 0 && <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-subtle px-2 py-1.5">{chips.map((chip, index) => <button key={index} aria-label={`Remove ${chip.label} filter`} onClick={() => update(chip.patch)} className="flex h-6 max-w-48 items-center gap-1 rounded-md border border-subtle bg-surface-2 px-1.5 text-[11px]"><span className="truncate">{chip.label}</span><X size={10} className="shrink-0" /></button>)}</div>}
    {(searchOpen || !!fileFilter) && <ReviewFileFilter value={fileFilter} onChange={view.setFileFilter} />}
    {loading && files.length > 0 && <div role="status" className="flex shrink-0 items-center gap-2 px-2 py-1 text-xs text-muted">Loading agent changes</div>}
    {pending && !files.length && <LoadingState label="Loading agent changes" className="p-4 text-xs" />}
    {error && <p role="alert" className="px-3 py-2 text-xs text-red-400">{error} <button type="button" disabled={loading} className="underline disabled:opacity-30" onClick={() => void send({ kind: 'refresh' })}>Retry</button></p>}
    <div ref={root} data-review-scroll className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
      {loading && !pending && !files.length && <LoadingState label="Loading recorded changes" className="h-full p-4 text-xs" />}
      {!loading && !error && !files.length && <div data-review-empty role="status" className="flex h-full w-full items-center justify-center px-6 py-8 text-center">
        <div data-review-empty-content className="max-w-sm">
          <GitCompareArrows size={28} className="mx-auto mb-3 text-muted" />
          <p className="text-sm font-medium text-secondary">{!agents.length ? 'No recorded changes yet' : 'No matching changes'}</p>
          <p className="mt-2 text-xs leading-relaxed text-muted">{!agents.length ? 'Recorded agent edits will appear here.' : 'Try another source panel or clear the file filter.'}</p>
        </div>
      </div>}

      {!pending && groups.map(([groupKey, groupFiles], groupIndex) => {
        const file = groupFiles[0]
        const title = view.grouping === 'conversation' ? `Conversation ${(file.sessionId ?? file.recordId).slice(0, 8)}` : file.commit?.message ?? (file.uncommitted ? 'Uncommitted changes' : 'Other recorded edits')
        const isCollapsed = collapsedGroups.has(groupKey)
        return <section key={groupKey} data-review-group={groupKey}>
          {view.grouping === 'pullRequest' && (groupIndex === 0 || groups[groupIndex - 1][1][0].prNumber !== file.prNumber) && <div className="border-b border-subtle bg-surface-2 px-3 py-2 text-xs font-medium" title="The pull request checkout associated with these edits when captured">{file.prNumber ? `Recorded for PR #${file.prNumber}` : 'No recorded pull request'}</div>}
          <button type="button" aria-expanded={!isCollapsed} aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${file.commit ? 'commit ' : ''}${title}`}
            onClick={() => view.toggleGroup(groupKey)} className="flex w-full min-w-0 items-center gap-2 border-b border-subtle bg-surface-1 px-3 py-2 text-left text-xs text-secondary hover:bg-hover">
            {isCollapsed ? <CaretRight size={12} /> : <CaretDown size={12} />}
            <GitCommitHorizontal size={14} className="shrink-0" />
            <span data-review-group-title className="min-w-0 flex-1 truncate">{title}</span>
            <span className="shrink-0 text-[10px] text-muted">{groupFiles.length} {groupFiles.length === 1 ? 'edit' : 'edits'}</span>
            {file.commit && <span title={file.commit.hash} className="font-mono text-[10px] text-muted">{file.commit.hash.slice(0, 7)}</span>}
          </button>
          {!isCollapsed && groupFiles.map((file) => {
            const key = keyOf(file)
            const agent = agentDisplayName(file.agentId)
            const sourcePanels = filter.panelId ? [] : file.panelIds.map((id) => byId.get(id)).filter((panel): panel is PanelRecord => !!panel)
            return <section key={key} data-review-file={encodeURIComponent(file.path)} className="min-w-0 border-b border-subtle scroll-mt-2">
            <div className="sticky top-0 z-10 flex w-full items-center gap-2 border-b border-subtle bg-surface-2/95 px-2 py-1.5 backdrop-blur">
              <button aria-label={`${expanded.has(key) ? 'Collapse' : 'Expand'} ${file.path}`} aria-expanded={expanded.has(key)} onClick={() => view.toggleExpanded(key)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                {expanded.has(key) ? <CaretDown size={12} /> : <CaretRight size={12} />}
                <span title={agent} className="w-4 h-4 shrink-0 rounded bg-surface-4 flex items-center justify-center text-[9px]">{agent[0]}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{file.oldPath ? `${file.oldPath} → ` : ''}{file.path}</span>
              </button>
              {sourcePanels.map((panel) => <button key={panel.id} aria-label={`Go to ${titles.label(panel)}`} title={`Go to ${titles.label(panel)}`} onClick={() => { void revealPanel(workspaceId, panel.id) }} className="inline-flex min-w-0 max-w-40 items-center gap-1 rounded-full border border-subtle bg-surface-3 px-2 py-0.5 text-[10px] text-secondary hover:bg-hover hover:text-primary"><PanelTitle {...titles.props(panel)} iconSize={10} /></button>)}
              {!filter.panelId && file.panelIds.filter((id) => !byId.has(id)).map((id) => <span key={id} className="max-w-40 truncate text-[10px] text-muted" title="Source panel closed"><PanelTitle record={{ type: 'terminal', title: panelChoices.get(id) ?? 'Closed panel' }} decoration={{ logo: agentLogo(file.agentId), logoAlt: agent }} iconSize={10} /></span>)}
              <span className="text-[10px] tabular-nums text-diff-add">+{file.additions}</span><span className="text-[10px] tabular-nums text-diff-del">−{file.deletions}</span>
              {file.coverage === 'fragment' && <span title="Reported edit fragment; full-file context and line numbers are unavailable." className="text-muted"><Info size={12} /></span>}
            </div>
            {expanded.has(key) && <RecordedFileBody
              key={key}
              send={send}
              file={file}
              display={display}
              page={view.pageFor(key)}
              setPage={(page) => view.setPage(key, page)}
            />}
          </section>
          })}
        </section>
      })}

    </div>
  </div>
}

/** Mounted only after the reader opens a file; fetch one bounded diff page. */
function RecordedFileBody({ send, file, display, page, setPage }: {
  send: ReviewSend
  file: RecordedFileSummary
  display: ReviewDisplay
  page: number
  setPage(page: number): void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [body, setBody] = useState<RecordedDiffPage | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setBody(null)
    setFailed(false)
    send({ kind: 'recordedDiff', recordId: file.recordId, path: file.path, page }).then(
      (result) => { if (live) setBody(result as RecordedDiffPage) },
      () => { if (live) setFailed(true) },
    )
    return () => { live = false }
  }, [send, page, attempt, file.recordId, file.path])
  return <div ref={root} className="w-full min-w-0 font-mono text-[11px] leading-[1.45]">
    {failed ? <div role="alert" className="px-3 py-2 font-sans text-red-400">Could not load this recorded edit. <button type="button" className="underline" onClick={() => setAttempt((value) => value + 1)}>Retry</button></div>
      : !body ? <p role="status" className="px-3 py-3 font-sans text-xs text-muted">Loading recorded diff…</p>
      : <>
        {file.coverage === 'unavailable' && <p className="px-3 py-2 text-muted">No patch was reported for this file.</p>}
        <div data-review-diff-scroll className="w-full min-w-0 overflow-x-auto">
          <div className={display.wrap ? 'w-full min-w-0 whitespace-pre-wrap break-all' : 'w-max min-w-full whitespace-pre'}>
            <GitDiff hunks={body.hunks} {...display} numbered={file.coverage === 'patch'} />
          </div>
        </div>
        <Pagination label="diff page" page={body.page} pageCount={body.pageCount} onChange={(next) => { setPage(next); root.current?.scrollIntoView?.({ block: 'start' }) }} />
      </>}
  </div>
}
