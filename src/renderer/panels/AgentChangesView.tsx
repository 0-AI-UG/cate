import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowClockwise, CaretDown, CaretRight, DotsThree, Funnel, Info, Rows, SplitHorizontal, X } from '@phosphor-icons/react'
import { ReviewToolbar } from './ReviewToolbar'
import { RecordedReviewButton } from './RecordedReviewButton'
import { RecordedDiffHunk, ReviewDisplayOptions, ReviewFileFilter, ReviewRunStatus, ReviewStats, ToolbarButton } from './GitReviewPanel'
import { getAgentLogoById } from '../lib/agent/agentLogos'
import { PopoverSurface, useDismissableLayer, useViewportPopoverPosition } from '../ui/Popover'
import { AGENTS } from '../../shared/agents'
import { filterAgentChanges } from '../../shared/agentChanges'
import type { AgentChangesFilter } from '../../shared/agentChanges'
import type { PanelProps } from './types'
import type { ReviewPanelState, WorkspaceState } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { refreshAgentChanges, useAgentChanges } from '../lib/useAgentChanges'
import { revealPanel } from '../lib/workspace/panelReveal'
import { LoadingState, Spinner } from '../ui/Spinner'
import { PANEL_TYPE_TINT, TabIcon, useWorktreeColorByPanel } from '../docking/DockTabBar'
import { useAgentInfoByPanel } from '../hooks/useAgentPanelInfo'

export default function AgentChangesView({ workspaceId, panelId }: PanelProps) {
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const state = workspace?.panels[panelId]?.reviewState
  // Session restore and workspace switches can remove the backing record
  // before the host unmounts. Keep data-dependent hooks in a guarded child.
  if (!workspace || !state) return <LoadingState label="Loading review panel…" className="h-full p-4 text-xs" />
  return <AgentChangesContent key={`${workspaceId}:${panelId}`} workspaceId={workspaceId} panelId={panelId} workspace={workspace} state={state} />
}

function AgentChangesContent({ workspaceId, panelId, workspace, state }: PanelProps & { workspace: WorkspaceState; state: ReviewPanelState }) {
  const titleColors = useWorktreeColorByPanel()
  const agentInfo = useAgentInfoByPanel(workspaceId)
  const filter = state.agentChanges ?? {}
  const { records, loading, error } = useAgentChanges(state.repoPath, workspaceId)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const morePopover = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!moreOpen) return
    const close = (event: PointerEvent) => { if (!morePopover.current?.contains(event.target as Node)) setMoreOpen(false) }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [moreOpen])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const { pos, portalTarget } = useViewportPopoverPosition(trigger, open, (rect) => ({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 264)), gap: 6, height: 180 }), popover)
  useDismissableLayer({ open, contentRef: popover, triggerRefs: [trigger], onDismiss: () => setOpen(false) })
  useEffect(() => { if (open && pos) popover.current?.querySelector('select')?.focus() }, [open, !!pos])
  const update = (patch: Partial<AgentChangesFilter>) => useAppStore.getState().setPanelReviewState(workspaceId, panelId, {
    ...state, agentChanges: { ...filter, ...patch },
  })
  const panels = Object.values(workspace?.panels ?? {}).filter((p) => p.type === 'terminal' || p.type === 'agent')
  const panelThread = filter.panelId ? workspace?.panels[filter.panelId]?.agentThreadId : undefined
  const selected = useMemo(() => filterAgentChanges(records, filter, panelThread), [records, filter, panelThread])
  const panelChoices = new Map(panels.map((p) => [p.id, p.title]))
  for (const record of records) for (const id of [record.panelId, ...(record.panelIds ?? [])]) if (id && !panelChoices.has(id)) panelChoices.set(id, `Closed panel ${panelChoices.size + 1}`)
  if (filter.panelId && !panelChoices.has(filter.panelId)) panelChoices.set(filter.panelId, 'Source panel (closed)')
  const query = (state.fileFilter ?? '').toLowerCase()
  const files = selected.flatMap((record) => record.files.filter((file) => !query || file.path.toLowerCase().includes(query)).map((file) => ({ record, file })))
  const totals = files.reduce((sum, { file }) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 })
  const display = state.display ?? { split: false, wordDiff: true, wrap: false }
  const updateDisplay = (patch: Partial<typeof display>) => useAppStore.getState().setPanelReviewState(workspaceId, panelId, { ...state, display: { ...display, ...patch } })
  const allCollapsed = files.length > 0 && files.every(({ record, file }) => collapsed.has(`${record.id}:${file.path}`))
  useEffect(() => {
    if (!state.focusedFile) return
    root.current?.querySelector(`[data-review-file="${encodeURIComponent(state.focusedFile)}"]`)?.scrollIntoView?.({ block: 'start' })
  }, [state.focusedFile, selected])
  const chips = [
    filter.agentId && { label: AGENTS.find((a) => a.id === filter.agentId)?.displayName ?? 'Agent', patch: { agentId: undefined } },
    filter.panelId && { label: panelChoices.get(filter.panelId)!, patch: { panelId: undefined, sessionId: undefined, turnId: undefined } },
    filter.sessionId && { label: 'This conversation', patch: { sessionId: undefined, turnId: undefined } },
    filter.turnId && { label: 'This turn', patch: { turnId: undefined } },
  ].filter(Boolean) as { label: string; patch: Partial<AgentChangesFilter> }[]
  const selectClass = 'h-7 w-full rounded-lg bg-surface-2 border border-subtle px-2 text-xs'
  return <div className="flex h-full min-h-0 flex-col bg-surface-0 text-primary">
    <ReviewToolbar state={state} workspaceId={workspaceId} panelId={panelId}>
      <button ref={trigger} aria-label="Filters" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs hover:bg-surface-2"><Funnel size={14} />Filters</button>
      <div className="ml-auto flex items-center gap-1">
        <ReviewRunStatus state={state} workspace={workspace} workspaceId={workspaceId} panelId={panelId} />
        <ReviewStats files={new Set(files.map(({ file }) => file.path)).size} additions={totals.additions} deletions={totals.deletions} />
        <ToolbarButton label="Refresh" disabled={loading || refreshing} onClick={async () => { setRefreshing(true); try { await refreshAgentChanges(state.repoPath, workspaceId) } finally { setRefreshing(false) } }}>{loading || refreshing ? <Spinner size={14} label="Refreshing changes" /> : <ArrowClockwise size={14} />}</ToolbarButton>
        <RecordedReviewButton records={selected.map((record) => ({ ...record, files: record.files.filter((file) => !query || file.path.toLowerCase().includes(query)) }))} cwd={state.repoPath} workspaceId={workspaceId} panelId={panelId} working={state.agentReview?.status === 'working'} />
        <ToolbarButton label={display.split ? 'Switch to unified diff' : 'Switch to split diff'} onClick={() => updateDisplay({ split: !display.split })}>{display.split ? <Rows size={14} /> : <SplitHorizontal size={14} />}</ToolbarButton>
        <div ref={morePopover} className="relative">
          <ToolbarButton label="More review options" active={moreOpen} onClick={() => setMoreOpen(!moreOpen)}><DotsThree size={16} /></ToolbarButton>
          {moreOpen && <div role="menu" className="absolute right-0 top-8 z-50 w-56 rounded-xl border border-subtle bg-surface-2 p-1 shadow-xl"><ReviewDisplayOptions display={display} update={updateDisplay} /></div>}
        </div>
        <span className="text-muted" title="Recorded agent edits, not the current Git diff. Shell-generated or unreported edits may be missing. Counts are recorded edit totals."><Info size={14} aria-label="About recorded edits" /></span>
      </div>
    </ReviewToolbar>
    {chips.length > 0 && <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-subtle px-2 py-1.5">{chips.map((chip, index) => <button key={index} aria-label={`Remove ${chip.label} filter`} onClick={() => update(chip.patch)} className="flex h-6 max-w-48 items-center gap-1 rounded-md border border-subtle bg-surface-2 px-1.5 text-[11px]"><span className="truncate">{chip.label}</span><X size={10} className="shrink-0" /></button>)}</div>}
    {open && <PopoverSurface popoverRef={popover} pos={pos} portalTarget={portalTarget} width={256} className="p-3 text-primary">
      <div role="dialog" aria-label="Change filters" className="space-y-3">
      <label className="block text-xs">Agent
      <select aria-label="Filter by agent" value={filter.agentId ?? ''} className={selectClass}
        onChange={(event) => update({ agentId: event.target.value as AgentChangesFilter['agentId'] || undefined, sessionId: undefined, turnId: undefined })}>
        <option value="">All agents</option>{AGENTS.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}
      </select>
      </label><label className="block text-xs">Panel
      <select aria-label="Filter by panel" value={filter.panelId ?? ''} className={selectClass}
        onChange={(event) => update({ panelId: event.target.value || undefined, sessionId: undefined, turnId: undefined })}>
        <option value="">All panels</option>{[...panelChoices].map(([id, title]) => <option key={id} value={id}>{title}</option>)}
      </select>
      </label>
      <div className="flex justify-between text-xs"><button onClick={() => update({ agentId: undefined, panelId: undefined, sessionId: undefined, turnId: undefined })}>Clear filters</button><button onClick={() => { setOpen(false); trigger.current?.focus() }}>Done</button></div>
      </div>
    </PopoverSurface>}
    <ReviewFileFilter value={state.fileFilter ?? ''} onChange={(fileFilter) => useAppStore.getState().setPanelReviewState(workspaceId, panelId, { ...state, fileFilter })} allCollapsed={allCollapsed} disabled={!files.length} onToggleCollapsed={() => setCollapsed(new Set(allCollapsed ? [] : files.map(({ record, file }) => `${record.id}:${file.path}`)))} />
    {error && <p role="alert" className="px-3 py-2 text-xs text-red-400">{error}</p>}
    <div ref={root} className="min-h-0 flex-1 overflow-auto">
      {loading && <LoadingState label="Loading recorded changes…" className="h-full p-4 text-xs" />}
      {!loading && !files.length && <p className="p-4 text-xs text-muted">No recorded edits match these filters. This does not mean the agent made no changes.</p>}
      {files.map(({ record, file }) => {
        const key = `${record.id}:${file.path}`
        const logo = getAgentLogoById(record.agentId)
        const agent = AGENTS.find((a) => a.id === record.agentId)?.displayName ?? 'Agent'
        const sourceIds = new Set(record.source === 'terminal'
          ? record.panelId ? [record.panelId] : []
          : [...(record.panelIds ?? []), ...panels.filter((panel) => panel.type === 'agent' && panel.agentThreadId === record.sourceId).map((panel) => panel.id)])
        const sourcePanels = [...sourceIds].map((id) => workspace.panels[id]).filter((panel) => panel?.type === 'terminal' || panel?.type === 'agent')
        return <section key={key} data-review-file={encodeURIComponent(file.path)} className="min-w-0 border-b border-subtle scroll-mt-2">
          <div className="sticky top-0 z-10 flex w-full items-center gap-2 border-b border-subtle bg-surface-2/95 px-2 py-1.5 backdrop-blur">
          <button aria-expanded={!collapsed.has(key)} onClick={() => setCollapsed((previous) => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next })} className="flex min-w-0 flex-1 items-center gap-2 text-left">
            {collapsed.has(key) ? <CaretRight size={12} /> : <CaretDown size={12} />}
            {logo && <img src={logo} alt={agent} title={agent} className="h-4 w-4 shrink-0" />}
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{file.oldPath ? `${file.oldPath} → ` : ''}{file.path}</span>
          </button>
            {sourcePanels.map((panel) => <button key={panel.id} aria-label={`Go to ${panel.title}`} title={`Go to ${panel.title}`} onClick={() => void revealPanel(workspaceId, panel.id)} className="inline-flex min-w-0 max-w-40 items-center gap-1 rounded-full border border-subtle bg-surface-3 px-2 py-0.5 text-[10px] text-secondary hover:bg-hover hover:text-primary"><span className={`shrink-0 ${PANEL_TYPE_TINT[panel.type]}`}><TabIcon type={panel.type} size={11} logo={agentInfo[panel.id]?.logo} agentName={agentInfo[panel.id]?.name} /></span><span className="truncate" style={{ color: titleColors[panel.id] }}>{panel.title}</span></button>)}
            {sourcePanels.length === 0 && <span className="text-[10px] text-muted" title="The source panel is no longer available">Panel closed</span>}
            <span className="text-[10px] tabular-nums text-diff-add">+{file.additions}</span><span className="text-[10px] tabular-nums text-diff-del">−{file.deletions}</span>
            {file.coverage === 'fragment' && <span title="Reported edit fragment; full-file context and line numbers are unavailable." className="text-muted"><Info size={12} /></span>}
          </div>
          {!collapsed.has(key) && <div className={`font-mono text-[11px] leading-[1.45] ${display.wrap ? 'w-full min-w-0 whitespace-pre-wrap break-all' : 'w-max min-w-full whitespace-pre'}`}>
            {file.coverage === 'unavailable' && <p className="px-3 py-2 text-muted">No patch was reported for this file.</p>}
            {file.hunks.map((hunk, index) => <RecordedDiffHunk key={index} split={display.split} wordDiff={display.wordDiff} wrap={display.wrap} hunk={file.coverage === 'fragment' ? { ...hunk, lines: hunk.lines.map((line) => ({ ...line, oldLine: null, newLine: null })) } : hunk} />)}
          </div>}
        </section>
      })}
    </div>
  </div>
}
