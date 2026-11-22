import { useMemo, useRef, useState } from 'react'
import { Crosshair, Ellipsis, GitCompareArrows, Search, X } from 'lucide-react'
import { LoadingState, Tooltip } from '../../kernel/interaction'
import { clientUi, errorMessage } from '@kernel/interaction'
import { useDocument } from '../../client/document'
import type { AgentId } from '@services/agents/contract'
import type { PanelRecord } from '@workspace/document/contract'
import type { ReviewSnapshot } from '@panels/review/contract'
import { pickPanelPlace, revealPanel } from '@client/host'
import { PanelTitle, usePanelTitles } from '../../client/host'
import { pickReviewTerminal } from './parts/pickTerminal'
import { ReviewToolbar } from './ReviewToolbar'
import { ReviewAgentButton, ReviewSearch, ToolbarButton } from './ReviewControls'
import { ReviewTree } from './ReviewTree'
import { sourcePanelId, terminalTitle, useAgentPicker, useReviewView, type ReviewSend, type ReviewTerminal } from './useReview'


const sameRecords = (a: PanelRecord[], b: PanelRecord[]) => a.length === b.length && a.every((item, index) => item === b[index])
const countLabel = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`
const scopeIconClass = 'flex h-full w-6 shrink-0 items-center justify-center border-subtle text-muted hover:bg-hover hover:text-primary disabled:opacity-40 disabled:hover:bg-transparent'

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
    label="Review with…"
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
  const scope = review.agentChanges ?? {}
  const [pending, setPending] = useState(false)
  const loading = recorded.loading || refreshing || pending
  const error = sessionError ?? recorded.error
  const root = useRef<HTMLDivElement>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const setPanelScope = async (panelId: string | null) => {
    setPending(true)
    try { await send({ kind: 'updateFilter', patch: { panelId, sessionId: null, turnId: null } }) }
    catch (cause) { clientUi().showError(errorMessage(cause, 'Could not update the review scope')) }
    finally { setPending(false) }
  }
  const selectPanel = async () => {
    const place = await pickPanelPlace({ workspaceId, panelType: 'terminal', availability: 'existing', sourcePanelId: panelId })
    if (place?.kind === 'existing') await setPanelScope(place.panelId)
  }
  const view = useReviewView(workspaceId, panelId, snapshot)
  const { display, expanded, updateDisplay, fileFilter } = view
  const query = fileFilter.trim().toLowerCase()
  const terminals = useMemo(() => {
    const entries = new Map<string, ReviewTerminal>(recorded.panels.map(({ id, title }, index) => [id, { title, index }]))
    for (const panel of panels) if (panel.type === 'terminal') {
      entries.set(panel.id, { title: titles.label(panel), index: entries.get(panel.id)?.index ?? Infinity, panel })
    }
    return entries
  }, [recorded.panels, panels, titles])
  const files = useMemo(() => query ? recorded.files.filter((file) => file.path.toLowerCase().includes(query)
    || file.oldPath?.toLowerCase().includes(query)
    || terminalTitle(file, sourcePanelId(file, scope.panelId), terminals).toLowerCase().includes(query)) : recorded.files,
  [recorded.files, query, scope.panelId, terminals])
  const scopeLabel = scope.turnId ? 'This turn' : scope.sessionId ? 'This conversation'
    : scope.panelId ? terminals.get(scope.panelId)?.title ?? 'This terminal' : null
  const panelScope = !scope.sessionId && !scope.turnId ? scope.panelId : undefined
  const scopedPanel = scope.panelId ? terminals.get(scope.panelId)?.panel : undefined
  const scopeTitle = panelScope && scopeLabel
    ? <PanelTitle {...(scopedPanel ? titles.props(scopedPanel) : { record: { type: 'terminal', title: scopeLabel } })} iconSize={13} />
    : <span className="truncate">{scopeLabel ?? 'All terminals'}</span>
  const summary = useMemo(() => {
    const paths = new Set<string>()
    const sources = new Set<string>()
    for (const file of files) {
      paths.add(file.path)
      const id = sourcePanelId(file)
      if (id) sources.add(id)
    }
    return { paths: paths.size, sources: sources.size }
  }, [files])
  const searching = searchOpen || !!fileFilter
  const closeSearch = () => {
    view.setFileFilter('')
    setSearchOpen(false)
  }
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
  return <div className="flex w-full min-w-0 h-full min-h-0 flex-col overflow-hidden bg-surface-0 text-primary">
    <ReviewToolbar review={review} busy={loading} send={send}
      scope={<div className="flex h-7 min-w-0 max-w-full items-center rounded-lg border border-subtle bg-surface-2 text-xs text-secondary">
        <Tooltip label="Select source panel on canvas">
          <button type="button" aria-label="Select source panel on canvas" disabled={loading || !panels.some((panel) => panel.type === 'terminal')}
            onClick={() => void selectPanel()} className={`${scopeIconClass} rounded-l-lg border-r`}>
            <Crosshair size={13} aria-hidden="true" />
          </button>
        </Tooltip>
        {scopedPanel ? <Tooltip label={`Go to ${titles.label(scopedPanel)}`}>
          <button type="button" data-review-scope-label aria-label={`Go to ${titles.label(scopedPanel)}`}
            onClick={() => void revealPanel(workspaceId, scopedPanel.id)}
            className="flex h-full min-w-0 items-center rounded px-1.5 text-left hover:bg-hover hover:text-primary">{scopeTitle}</button>
        </Tooltip> : <span data-review-scope-label title={scopeLabel ?? 'All terminals'} className="flex min-w-0 items-center px-1.5">{scopeTitle}</span>}
        {scopeLabel && <Tooltip label="Show all recorded edits">
          <button type="button" aria-label={`Clear review scope: ${scopeLabel}`} disabled={pending}
            onClick={() => void setPanelScope(null)} className={`${scopeIconClass} rounded-r-lg border-l`}>
            <X size={13} aria-hidden="true" />
          </button>
        </Tooltip>}
      </div>}
      center={searching
        ? <ReviewSearch value={fileFilter} autoFocus={searchOpen} onChange={view.setFileFilter} onClose={closeSearch} />
        : !loading && <div className="min-w-0 truncate text-center text-xs tabular-nums text-muted" data-review-summary>
          {!scope.panelId && <span className="review-summary-detail">{countLabel(summary.sources, 'terminal', 'terminals')} · </span>}
          {countLabel(summary.paths, 'file', 'files')}
          <span className="review-summary-detail"> · {countLabel(files.length, 'edit', 'edits')}</span>
        </div>}
      actions={<>
        {!searching && <ToolbarButton label="Search files and terminals" onClick={() => setSearchOpen(true)}><Search size={14} /></ToolbarButton>}
        <RecordedReviewButton workspaceId={workspaceId} panelId={panelId} send={send} busy={agentBusy} disabled={!recorded.files.length} />
        <ToolbarButton label="More review options" active={moreOpen} onClick={() => void showOptions()}><Ellipsis size={16} /></ToolbarButton>
      </>}
    />
    {loading && files.length > 0 && <div role="status" className="flex shrink-0 items-center gap-2 px-2 py-1 text-xs text-muted">Loading agent changes</div>}
    {pending && !files.length && <LoadingState label="Loading agent changes" className="p-4 text-xs" />}
    {error && <p role="alert" className="px-3 py-2 text-xs text-red-400">{error} <button type="button" disabled={loading} className="underline disabled:opacity-30" onClick={() => void send({ kind: 'refresh' })}>Retry</button></p>}
    <div ref={root} data-review-scroll className="relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
      {loading && !pending && !files.length && <LoadingState label="Loading recorded changes" className="h-full p-4 text-xs" />}
      {!loading && !error && !files.length && <div data-review-empty role="status" className="flex h-full w-full items-center justify-center px-6 py-8 text-center">
        <div data-review-empty-content className="max-w-sm">
          <GitCompareArrows size={28} className="mx-auto mb-3 text-muted" />
          <p className="text-sm font-medium text-secondary">{query || scopeLabel ? 'No matching changes' : 'No recorded changes yet'}</p>
          <p className="mt-2 text-xs leading-relaxed text-muted">{query ? 'Try another file path or terminal name.'
            : scopeLabel ? 'Clear the review scope to see all recorded edits.' : 'Recorded agent edits will appear here.'}</p>
        </div>
      </div>}

      {!pending && files.length > 0 && <ReviewTree key={review.repoPath} workspaceId={workspaceId} scrollRef={root}
        files={files} source={scope.panelId} terminals={terminals} titles={titles} view={view} send={send} />}
    </div>
  </div>
}
