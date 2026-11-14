import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, CircleHelp, Laptop, Terminal, Undo2 } from 'lucide-react'
import { machineOf, type WorkspaceEntry } from '@client/workspaces'
import { agentPanelTitle, watchAgentChat } from '@services/agents/client'
import type { AgentConversation } from '@services/agents/contract'
import { useClientState, useDocument } from '../../client/document'
import { Button, Spinner, Tooltip } from '../../kernel/interaction'
import { useConnectionState } from '../../client/connections'
import { AgentMark, useAgentPanels } from '../../services/agents'
import { clientApp } from '../app'
import { runWindowAction } from '../actions/run'
import { revealPanel, selectWorkspace } from '../navigation'
import { useTerminalStatuses } from '../state/statusStore'
import { setUiState, useUiState } from '../state/uiState'
import { useUIStore } from '../state/uiStore'
import { groupThreads, threadActivity, threadAge, threadKey, type SidebarThread } from './threadActivity'
import { ThreadSnooze } from './ThreadSnooze'

const PROJECT_BADGE_COLORS = ['bg-lime-400/10 text-lime-400', 'bg-pink-400/10 text-pink-400', 'bg-blue-400/10 text-blue-400', 'bg-violet-400/10 text-violet-400', 'bg-amber-400/10 text-amber-400']

function ProjectBadge({ name }: { name: string }) {
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const initials = words.length > 1 ? words[0][0] + words.at(-1)![0] : name.slice(0, 2)
  const color = PROJECT_BADGE_COLORS[Math.max(0, (name.toUpperCase().charCodeAt(0) || 65) - 65) % PROJECT_BADGE_COLORS.length]
  return <span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-semibold ${color}`}>{initials.toUpperCase()}</span>
}

function ThreadDetails({ thread }: { thread: SidebarThread }) {
  return (
    <div className="min-w-[180px] max-w-[260px] space-y-2 px-1.5 py-2 text-xs">
      <p className="font-medium leading-5 text-primary">{thread.title}</p>
      <div className="flex items-center gap-2 text-secondary"><ProjectBadge name={thread.workspaceName} /><span className="truncate">{thread.workspaceName}</span></div>
      <div className="flex items-center gap-2 text-secondary"><Laptop size={16} /><span>{thread.machineName}</span></div>
      <div className="flex items-center gap-2 text-secondary">{thread.agentId ? <AgentMark agent={thread.agentId} size={16} /> : <Terminal size={16} />}<span>{thread.agentName || 'Terminal'}</span></div>
    </div>
  )
}

function ThreadAge({ thread, settledAt, visible }: { thread: SidebarThread; settledAt?: number; visible: boolean }) {
  const [replyAt, setReplyAt] = useState<number>()
  const [now, setNow] = useState(Date.now)
  const at = settledAt ?? thread.completedAt ?? replyAt
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [visible])
  useEffect(() => {
    setReplyAt(undefined)
    if (!visible || !thread.agentId || settledAt !== undefined || thread.completedAt !== undefined) return
    const chat = watchAgentChat(thread.workspaceId, thread.panel.id)
    const update = () => {
      const date = chat.get()?.messages.findLast((message) => message.role === 'assistant')?.createdAt
      const timestamp = Date.parse(date ?? '')
      setReplyAt(Number.isFinite(timestamp) ? timestamp : undefined)
    }
    const off = chat.subscribe(update)
    update()
    return () => { off(); chat.release() }
  }, [visible, thread.workspaceId, thread.panel.id, thread.agentId, thread.completedAt, settledAt])
  return <span className="text-xs tabular-nums text-secondary transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
    title={at !== undefined ? `${settledAt !== undefined ? 'Settled' : 'Completed'} ${new Date(at).toLocaleString()}` : 'Completion time unavailable'}>{threadAge(at, now)}</span>
}

/** Observe only visible running cards, and release the conversation as soon
 *  as the turn ends. The title stays the CLI's saved session title. */
function ThreadActivity({ thread, visible }: { thread: SidebarThread; visible: boolean }) {
  const [activity, setActivity] = useState<string | null>(null)
  useEffect(() => {
    setActivity(null)
    if (!visible || !thread.agentId || thread.phase !== 'running') return
    const chat = watchAgentChat(thread.workspaceId, thread.panel.id)
    const update = () => setActivity(threadActivityText(chat.get()))
    const off = chat.subscribe(update)
    update()
    return () => { off(); chat.release() }
  }, [visible, thread.workspaceId, thread.panel.id, thread.agentId, thread.phase])
  if (thread.phase !== 'running' || !activity) return <span className="sr-only">{thread.label}</span>
  return <span className="mt-0.5 block truncate text-[11px] text-secondary" title={activity}>{activity}</span>
}

export function threadActivityText(chat: AgentConversation | null): string | null {
  if (!chat) return null
  const lastPrompt = chat.messages.findLastIndex((message) => message.role === 'user')
  const promptAt = Date.parse(chat.messages[lastPrompt]?.createdAt ?? '')
  const step = chat.steps.at(-1)
  const reply = chat.messages.slice(lastPrompt + 1).findLast((message) => message.role === 'assistant')
  const replyAt = Date.parse(reply?.createdAt ?? '')
  if (step && (lastPrompt < 0 || (Number.isFinite(promptAt) && Date.parse(step.at) >= promptAt))
    && (!reply || (Number.isFinite(replyAt) && Date.parse(step.at) >= replyAt))) {
    return step.subject ? `${step.tool}: ${step.subject}` : step.tool
  }
  // Never reuse the input prompt as an activity summary.
  return reply?.text.trim().split('\n').find((line) => line.trim())?.trim() || null
}

/** One observer per connected workspace. It stays mounted in Projects view,
 *  so command completions and a new turn invalidate settled acknowledgements. */
function WorkspaceThreads({ entry, report }: { entry: WorkspaceEntry; report: (id: string, threads: SidebarThread[]) => void }) {
  const panels = useDocument(entry.id, (doc) => doc.panels)
  const focusedId = useClientState(entry.id, (state) => state.focusedPanelId)
  const agents = useAgentPanels(entry.id, (states) => states)
  const terminals = useTerminalStatuses(entry.id)
  const connected = useConnectionState(clientApp().connections.get(entry.id)).kind === 'connected'
  const ran = useRef(new Set<string>())
  const completion = useRef(new Map<string, { phase: SidebarThread['phase']; at?: number }>())
  const threads = useMemo(() => {
    if (!connected) { ran.current.clear(); completion.current.clear(); return [] }
    const byPanel = new Map(Object.values(terminals).map((t) => [t.panelId, t]))
    const machine = machineOf(entry)
    const machineName = machine.kind === 'this' ? 'This device' : machine.label ?? 'Remote device'
    return Object.values(panels).flatMap((panel): SidebarThread[] => {
      const terminal = byPanel.get(panel.id)
      const agent = agents[panel.id]
      if (terminal?.activity.type === 'running' || agent?.status === 'running') ran.current.add(panel.id)
      const activity = threadActivity(agent, terminal, ran.current.has(panel.id))
      if (!activity) return []
      const previous = completion.current.get(panel.id)
      const finished = activity.phase === 'ready' || activity.phase === 'settled'
      const observedCompletion = previous?.phase === 'running' || previous?.phase === 'blocked'
        || (previous?.phase === 'ready' && activity.phase === 'settled')
      const completedAt = !finished ? undefined : previous?.phase === activity.phase ? previous.at
        : observedCompletion ? Date.now() : undefined
      completion.current.set(panel.id, { phase: activity.phase, at: completedAt })
      return [{ ...activity, key: threadKey(entry.id, panel.id), workspaceId: entry.id, workspaceName: entry.name,
        panel, focused: focusedId === panel.id, title: agentPanelTitle(panel.title, agent), agentId: agent?.agentId ?? null,
        agentName: agent?.agentName, machineName, completedAt }]
    })
  }, [connected, panels, agents, terminals, entry.id, entry.name, focusedId])
  useEffect(() => { report(entry.id, threads) }, [entry.id, threads, report])
  useEffect(() => () => report(entry.id, []), [entry.id, report])
  return null
}

export function ThreadList({ entries, open, hidden, query = '', projectId = '' }: { entries: readonly WorkspaceEntry[]; open: readonly string[]; hidden: boolean; query?: string; projectId?: string }) {
  const selectedWorkspaceId = useUIStore((state) => state.selectedWorkspaceId)
  const [byWorkspace, setByWorkspace] = useState<Record<string, SidebarThread[]>>({})
  const { sidebarSettledOpen, sidebarThreadSnoozes } = useUiState()
  // Keep acknowledgements within this live observation. After reopening the
  // app, a ready terminal may have completed another turn while disconnected.
  const [settledThreads, setSettledThreads] = useState<string[]>([])
  const [settledTimes, setSettledTimes] = useState<Record<string, number>>({})
  const [reopenedThreads, setReopenedThreads] = useState<string[]>([])
  const [snoozedOpen, setSnoozedOpen] = useState(false)
  const [actionThread, setActionThread] = useState<string | null>(null)
  const [snoozeMenuThread, setSnoozeMenuThread] = useState<string | null>(null)
  useEffect(() => {
    let timer: number | undefined
    const wake = () => {
      window.clearTimeout(timer)
      const awake = Object.fromEntries(Object.entries(sidebarThreadSnoozes).filter(([, until]) => until > Date.now()))
      if (Object.keys(awake).length !== Object.keys(sidebarThreadSnoozes).length) {
        setUiState('sidebarThreadSnoozes', awake)
        return
      }
      const next = Math.min(...Object.values(awake))
      if (Number.isFinite(next)) timer = window.setTimeout(wake, Math.min(Math.max(0, next - Date.now() + 1), 2_147_483_647))
    }
    wake()
    window.addEventListener('focus', wake)
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', wake) }
  }, [sidebarThreadSnoozes])
  const report = useCallback((id: string, threads: SidebarThread[]) => {
    setByWorkspace((prev) => ({ ...prev, [id]: threads }))
  }, [])
  const observedThreads = entries.filter((e) => open.includes(e.id)).flatMap((e) => byWorkspace[e.id] ?? [])
  const threads = observedThreads.map((thread): SidebarThread => thread.phase === 'settled' && reopenedThreads.includes(thread.key)
    ? { ...thread, phase: 'ready', label: 'Ready for review' } : thread)
  const search = query.trim().toLocaleLowerCase()
  const filtered = threads.filter((thread) => (!projectId || thread.workspaceId === projectId)
    && (!search || `${thread.title} ${thread.workspaceName} ${thread.label}`.toLocaleLowerCase().includes(search)))
  const snoozed = filtered.filter((thread) => sidebarThreadSnoozes[thread.key] > Date.now())
  const { attention, working, unknown, done } = groupThreads(filtered.filter((thread) => !snoozed.includes(thread)), settledThreads)
  const blocked = attention.filter((thread) => thread.phase === 'blocked')
  const ready = attention.filter((thread) => thread.phase === 'ready')
  // A new running turn or a new blocking prompt needs attention again.
  const readyKeys = JSON.stringify(threads.filter((t) => t.phase === 'ready').map((t) => t.key))
  useEffect(() => {
    const kept = settledThreads.filter((key) => (JSON.parse(readyKeys) as string[]).includes(key))
    if (kept.length !== settledThreads.length) {
      setSettledThreads(kept)
      setSettledTimes((times) => Object.fromEntries(Object.entries(times).filter(([key]) => kept.includes(key))))
    }
  }, [settledThreads, readyKeys])

  const exitedKeys = JSON.stringify(observedThreads.filter((thread) => thread.phase === 'settled').map((thread) => thread.key))
  useEffect(() => {
    setReopenedThreads((current) => {
      const kept = current.filter((key) => (JSON.parse(exitedKeys) as string[]).includes(key))
      return kept.length === current.length ? current : kept
    })
  }, [exitedKeys])

  const settle = (thread: SidebarThread) => {
    setSettledThreads([...settledThreads, thread.key])
    setSettledTimes((times) => ({ ...times, [thread.key]: Date.now() }))
  }
  const unSettle = (thread: SidebarThread) => {
    setSettledThreads((current) => current.filter((key) => key !== thread.key))
    setSettledTimes((times) => { const next = { ...times }; delete next[thread.key]; return next })
    setReopenedThreads((current) => current.includes(thread.key) ? current : [...current, thread.key])
  }
  const wakeThread = (thread: SidebarThread) => {
    const next = { ...sidebarThreadSnoozes }; delete next[thread.key]
    setUiState('sidebarThreadSnoozes', next)
  }
  const row = (thread: SidebarThread) => (
    <Tooltip key={thread.key} placement="right" suppressed={actionThread === thread.key || snoozeMenuThread === thread.key} label={`${thread.title}, ${thread.workspaceName}, ${thread.label}`} content={
      <ThreadDetails thread={thread} />
    }>
      <div className={`group relative mx-2 my-1 rounded-md transition-colors ${thread.focused && thread.workspaceId === selectedWorkspaceId ? 'bg-surface-2' : 'hover:bg-surface-2 focus-within:bg-surface-2'}`} data-thread-phase={thread.phase}>
        <button type="button" className="block w-full min-w-0 rounded-md px-2.5 py-2.5 text-left focus-visible:outline-offset-[-2px]"
          aria-label={`${thread.title}, ${thread.workspaceName}: ${thread.label}`}
          onClick={() => { useUIStore.getState().closeOverlay(); void revealPanel(thread.workspaceId, thread.panel.id) }}>
          <span className="mb-1 flex min-w-0 items-center gap-1.5">
            <ProjectBadge name={thread.workspaceName} />
            <span className={`min-w-0 flex-1 truncate text-xs text-secondary ${thread.phase === 'ready' && !settledThreads.includes(thread.key) ? 'group-hover:pr-[78px] group-focus-within:pr-[78px]' : 'group-hover:pr-6 group-focus-within:pr-6'}`}>{thread.workspaceName}</span>
            <span className={`flex shrink-0 items-center gap-1 text-[11px] group-hover:invisible group-focus-within:invisible ${thread.phase === 'running' ? 'text-blue-400' : thread.phase === 'blocked' ? 'text-amber-400' : 'text-secondary'}`}>
              {thread.phase === 'running' && <><Spinner size={11} /><span>Working</span></>}
              {thread.phase === 'blocked' && <><CircleHelp size={12} /><span>Needs you</span></>}
              {thread.phase === 'unknown' && <span>{thread.label}</span>}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5 text-primary">{thread.title}</span>
            <span className="shrink-0 text-secondary opacity-70">{thread.agentId ? <AgentMark agent={thread.agentId} size={14} /> : <Terminal size={14} />}</span>
          </span>
          <ThreadActivity thread={thread} visible={!hidden} />
        </button>
        {thread.phase === 'unknown' && thread.label === 'Hooks off' && (
          <button type="button" aria-label={`Enable status for ${thread.title}`} title="Enable agent hooks in workspace settings; relaunch the agent to apply"
            className="block px-2.5 pb-2 text-[11px] text-secondary hover:text-primary underline underline-offset-2"
            onClick={async () => { if (await selectWorkspace(thread.workspaceId)) useUIStore.getState().openSettings('agents') }}>
            Enable status tracking
          </button>
        )}
        {thread.phase !== 'settled' && !settledThreads.includes(thread.key) && (
          <div className="absolute right-2.5 top-2 flex h-5 items-center gap-2 bg-surface-2 pl-1 text-xs text-secondary opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            onMouseEnter={() => setActionThread(thread.key)} onMouseLeave={() => setActionThread(null)} onFocus={() => setActionThread(thread.key)} onBlur={() => setActionThread(null)}>
            <ThreadSnooze title={thread.title} onOpenChange={(isOpen) => setSnoozeMenuThread(isOpen ? thread.key : null)}
              onSnooze={(until) => setUiState('sidebarThreadSnoozes', { ...sidebarThreadSnoozes, [thread.key]: until })} />
            {thread.phase === 'ready' && <Tooltip label="Settle thread"><button type="button" aria-label={`Mark ${thread.title} settled`} onClick={() => settle(thread)} className="flex h-5 items-center gap-1 hover:text-primary"><Check size={13} /><span>Settle</span></button></Tooltip>}
          </div>
        )}
      </div>
    </Tooltip>
  )
  return (
    <div className={hidden ? 'hidden' : 'flex flex-col flex-1 min-h-0'} aria-label="Threads">
      {entries.filter((e) => open.includes(e.id)).map((entry) => <WorkspaceThreads key={entry.id} entry={entry} report={report} />)}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {blocked.length > 0 && <section aria-label="Needs attention">
          <div className="px-3 pt-3 pb-1 flex justify-between text-xs text-amber-400"><span>Needs your response</span><span>{blocked.length}</span></div>
          {blocked.map(row)}
        </section>}
        {ready.length > 0 && <section aria-label="Ready for review">
          <div className="px-3 pt-3 pb-1 flex justify-between text-xs text-secondary"><span>Ready for review</span><span>{ready.length}</span></div>
          {ready.map(row)}
        </section>}
        {working.length > 0 && <section aria-label="In progress">
          <div className="px-3 pt-3 pb-1 flex justify-between text-xs text-muted"><span>Working</span><span>{working.length}</span></div>
          {working.map(row)}
        </section>}
        {unknown.length > 0 && <section aria-label="Check status">
          <div className="px-3 pt-3 pb-1 flex justify-between text-xs text-secondary"><span>Check status</span><span>{unknown.length}</span></div>
          {unknown.map(row)}
        </section>}
        {attention.length === 0 && working.length === 0 && unknown.length === 0 && <div className="mx-3 mt-4 px-1 py-3">
          <p className="text-[13px] font-medium text-primary">{(search || projectId) && filtered.length === 0 ? 'No matching threads' : threads.length > 0 ? 'You’re all caught up' : 'No active threads'}</p>
          <p className="mt-1 text-xs leading-5 text-secondary">{search || projectId ? 'Try another project or search.' : 'Work that needs your response or review appears here.'}</p>
          {!search && !projectId && threads.length === 0 && <Button variant="secondary" size="sm" className="mt-3" onClick={() => runWindowAction('newTerminal')}><Terminal size={13} />New terminal</Button>}
        </div>}
      </div>
      {snoozed.length > 0 && <section className="shrink-0 max-h-[25%] overflow-y-auto" aria-label="Snoozed threads">
        <button type="button" aria-expanded={snoozedOpen} onClick={() => setSnoozedOpen(!snoozedOpen)} className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted hover:text-primary">
          <span className="flex-1 text-left">Snoozed</span><span>{snoozed.length}</span>{snoozedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {snoozedOpen && snoozed.map((thread) => <div key={thread.key} className="group mx-2 my-1 flex items-center gap-2 rounded-md px-2.5 py-2 hover:bg-surface-2">
          <ProjectBadge name={thread.workspaceName} /><span className="min-w-0 flex-1 truncate text-[13px] text-primary" title={`Snoozed until ${new Date(sidebarThreadSnoozes[thread.key]).toLocaleString()}`}>{thread.title}</span>
          <Tooltip label="Unsnooze thread"><button type="button" aria-label={`Unsnooze ${thread.title}`} onClick={() => wakeThread(thread)} className="p-1 text-secondary hover:text-primary"><Undo2 size={14} /></button></Tooltip>
        </div>)}
      </section>}
      <section className="shrink-0 flex flex-col max-h-[35%] min-h-0 pb-1" aria-label="Settled threads">
        <button type="button" aria-expanded={sidebarSettledOpen} aria-controls="sidebar-settled-threads"
          onClick={() => setUiState('sidebarSettledOpen', !sidebarSettledOpen)}
          className="flex items-center gap-2 px-3 py-2 text-xs text-muted hover:text-primary">
          <span className="flex-1 text-left">Settled</span><span>{done.length}</span>
          {sidebarSettledOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <div id="sidebar-settled-threads" className="overflow-y-auto min-h-0" hidden={!sidebarSettledOpen}>{done.map((thread) => <Tooltip key={thread.key} placement="right" label={`${thread.title}, ${thread.workspaceName}`} suppressed={actionThread === thread.key} content={<ThreadDetails thread={thread} />}><div data-thread-phase={thread.phase} className="group mx-2 my-1 flex items-center gap-2 rounded-md hover:bg-surface-2">
          <button type="button" aria-label={`${thread.title}, ${thread.workspaceName}`} className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left" onClick={() => { useUIStore.getState().closeOverlay(); void revealPanel(thread.workspaceId, thread.panel.id) }}>
            <ProjectBadge name={thread.workspaceName} /><span className="min-w-0 flex-1 truncate text-[13px] text-primary">{thread.title}</span>
          </button>
          <div className="relative mr-2 flex h-6 w-10 shrink-0 items-center justify-end">
            <ThreadAge thread={thread} settledAt={settledTimes[thread.key]} visible={!hidden && sidebarSettledOpen} />
            <Tooltip label="Move to needs attention"><button type="button" aria-label={`Un-settle ${thread.title}`} onClick={() => unSettle(thread)}
              className="absolute right-0 top-0 flex h-6 w-6 items-center justify-center text-secondary opacity-0 transition-opacity hover:text-primary group-hover:opacity-100 group-focus-within:opacity-100"
              onMouseEnter={() => setActionThread(thread.key)} onMouseLeave={() => setActionThread(null)} onFocus={() => setActionThread(thread.key)} onBlur={() => setActionThread(null)}><Undo2 size={14} /></button></Tooltip>
          </div>
        </div></Tooltip>)}</div>
      </section>
    </div>
  )
}
