import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Check, History, Crosshair, X } from 'lucide-react'
import { pickPanelPlace } from '@client/host'
import { PanelTitle, type usePanelTitles } from '../../client/host'
import { clientStateFor } from '@client/document'
import { AGENTS, agentDisplayName, type AgentChangesFilter } from '@services/agents/contract'
import type { AgentChangesFilterPatch, ReviewRecordedState } from '@panels/review/contract'
import type { PanelRecord } from '@workspace/document/contract'
import { AgentFlyout, AgentMark, agentLogo } from '../../services/agents'
import { useDismissableLayer, useHoverIntent, useViewportPopoverPosition } from '../../kernel/interaction'

export function ReviewFilters({ workspaceId, panelId, filter, panels, sources, agents, disabled, update, titles }: {
  workspaceId: string
  titles: ReturnType<typeof usePanelTitles>
  panelId: string
  filter: AgentChangesFilter
  panels: PanelRecord[]
  sources: ReviewRecordedState['panels']
  agents: ReviewRecordedState['agents']
  disabled: boolean
  update(patch: AgentChangesFilterPatch): void
}) {
  const box = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const panelButton = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState<'agent' | 'panel' | null>(null)
  const [pinned, setPinned] = useState(false)
  const close = () => { setOpen(null); setPinned(false) }
  const hover = useHoverIntent({ enabled: !disabled && open !== 'panel', open: () => setOpen('agent'), close: () => { if (!pinned) close() } })
  useDismissableLayer({ open: !!open, contentRef: menu, triggerRefs: [box, panelButton], onDismiss: close })
  const available = useMemo(() => AGENTS.filter((candidate) => agents.some((count) => count.agentId === candidate.id && count.edits > 0)).map((candidate) => candidate.id), [agents])
  const agent = filter.agentId
  const contributing = sources.filter((source) => agent && source.agentIds.includes(agent))
  const closedSources = contributing.filter((source) => !panels.some((panel) => panel.id === source.id))
  const { pos, portalTarget } = useViewportPopoverPosition(open === 'panel' ? panelButton : box, !!open, (rect) => {
    const width = menu.current?.getBoundingClientRect().width || (open === 'panel' ? 224 : 46)
    const left = open === 'panel' ? rect.left : rect.left + (rect.width - width) / 2
    return { left: Math.max(8, Math.min(left, window.innerWidth - width - 8)), gap: 6, height: open === 'panel' ? Math.min(256, 68 + closedSources.length * 28) : available.length * 40 }
  }, menu)
  const selectOnCanvas = async () => {
    hover.cancel()
    close()
    const place = await pickPanelPlace({ workspaceId, panelType: 'terminal', availability: 'existing', sourcePanelId: panelId })
    if (place?.kind === 'existing') update({ panelId: place.panelId, sessionId: null, turnId: null })
  }
  const selectedPanel = panels.find((panel) => panel.id === filter.panelId)
  const selectedSource = sources.find((source) => source.id === filter.panelId)
  const sourceTitle = (source: ReviewRecordedState['panels'][number]) => {
    const recordedAgent = agent ?? source.agentIds[0]
    return <PanelTitle record={{ type: 'terminal', title: source.title }} decoration={recordedAgent ? { logo: agentLogo(recordedAgent), logoAlt: agentDisplayName(recordedAgent) } : undefined} />
  }
  const itemClass = 'flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs text-secondary hover:bg-hover'
  return <div className="flex min-w-0 items-center gap-1.5">
    <div ref={box} className="relative shrink-0" onMouseEnter={hover.enter} onMouseLeave={hover.leave}>
      <button type="button" aria-label="Filter by agent" title={agent ? `${agentDisplayName(agent)} · Filter agent changes` : 'No recorded agents'} aria-haspopup="menu" aria-expanded={open === 'agent'}
        disabled={disabled || !available.length}
        onClick={() => { hover.cancel(); setOpen(open === 'agent' ? null : 'agent'); setPinned(open !== 'agent') }}
        className="flex h-7 items-center gap-0.5 rounded-full px-1.5 text-secondary hover:bg-hover disabled:opacity-30 disabled:grayscale">
        {agent ? <AgentMark agent={agent} size={18} /> : <Bot size={18} />}
      </button>
      {open && pos && portalTarget && createPortal(<div ref={menu} className="fixed z-[9999]"
        onPointerDown={(event) => { event.stopPropagation(); clientStateFor(workspaceId)?.focus(panelId) }}
        onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
        style={{ top: pos.top, left: pos.left, transform: pos.placement === 'above' ? 'translateY(-100%)' : undefined }}
        onMouseEnter={hover.enter} onMouseLeave={hover.leave}>
        {open === 'agent' ? <AgentFlyout agents={available}
          side={pos.placement === 'above' ? 'up' : 'down'} label="Filter agent changes" itemLabel={(name) => `Filter by ${name}`}
          onPick={(agentId) => { hover.cancel(); close(); update({ agentId, panelId: null, sessionId: null, turnId: null }) }} />
          : <div role="menu" aria-label="Closed source panels" className="max-h-64 w-56 overflow-y-auto rounded-lg border border-subtle bg-surface-1 p-1 shadow-lg">
            <button type="button" role="menuitem" className={itemClass} onClick={() => { close(); update({ panelId: null, sessionId: null, turnId: null }) }}>
              <span className="flex-1">All panels</span>{!filter.panelId && <Check size={12} />}
            </button>
            {closedSources.map((source) => {
              const title = source.title
              return <button key={source.id} type="button" role="menuitem" aria-label={title} className={itemClass} title={title}
                onClick={() => { close(); update({ panelId: source.id, sessionId: null, turnId: null }) }}>
                {sourceTitle(source)}
                <span className="text-[10px] text-muted">Closed</span>
                {filter.panelId === source.id && <Check size={12} className="shrink-0" />}
              </button>
            })}
          </div>}

      </div>, portalTarget)}
    </div>
    <button type="button" aria-label="Select source panel on canvas" title="Select a terminal panel on canvas"
      disabled={disabled || !panels.some((panel) => panel.type === 'terminal')} onClick={() => void selectOnCanvas()}
      className="flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-xs text-secondary hover:bg-hover disabled:opacity-30">
      <Crosshair size={14} /><span className="review-source-label">Select on canvas</span>
    </button>
    <button ref={panelButton} type="button" aria-label="Source panel history" aria-expanded={open === 'panel'} aria-haspopup="menu"
      disabled={disabled || !closedSources.length} onClick={() => { hover.cancel(); setOpen(open === 'panel' ? null : 'panel'); setPinned(open !== 'panel') }}
      className="flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-xs text-secondary hover:bg-hover disabled:opacity-30">
      <History size={14} /><span className="review-source-label">History</span><span className="text-muted">{closedSources.length}</span>
    </button>
    {filter.panelId && <button type="button" aria-label="Clear source panel filter" title="Show all source panels" disabled={disabled}
      onClick={() => update({ panelId: null, sessionId: null, turnId: null })}
      className="group relative h-7 min-w-0 max-w-40 rounded border border-subtle px-1.5 text-xs text-secondary hover:bg-hover">
      <span className="flex min-w-0 group-hover:max-w-[calc(100%-1rem)] group-focus-visible:max-w-[calc(100%-1rem)]">{selectedPanel ? <PanelTitle {...titles.props(selectedPanel)} /> : selectedSource ? sourceTitle(selectedSource) : <span className="truncate">Selected panel</span>}</span>
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-1.5 flex w-3 items-center justify-center opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"><X size={10} /></span>
    </button>}
  </div>
}
