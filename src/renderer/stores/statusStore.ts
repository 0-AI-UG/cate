import { create } from 'zustand'
import type { AgentState, TerminalActivity } from '../../shared/types'

export interface TerminalRuntimeStatus {
  activity: TerminalActivity
  agentState: AgentState
  agentName: string | null
  agentPresent: boolean
  listeningPorts: number[]
  cwd: string
}

export interface WorkspaceStatusState {
  /** Runtime state keyed once by terminal/pty id. */
  terminals: Record<string, TerminalRuntimeStatus>
}

interface StatusStoreState {
  workspaces: Record<string, WorkspaceStatusState>
}

let workspaceResolver: (ptyId: string) => string | undefined = () => undefined

export function setTerminalWorkspaceResolver(resolver: (ptyId: string) => string | undefined): void {
  workspaceResolver = resolver
}

export function workspaceIdForTerminal(ptyId: string): string | undefined {
  return workspaceResolver(ptyId)
}

interface StatusStoreActions {
  setTerminalActivity: (workspaceId: string, terminalId: string, activity: TerminalActivity) => void
  setAgentState: (workspaceId: string, terminalId: string, state: AgentState, name: string | null) => void
  setAgentName: (workspaceId: string, terminalId: string, name: string | null) => void
  setAgentPresent: (workspaceId: string, terminalId: string, present: boolean) => void
  statusText: (workspaceId: string) => string
  statusIcon: (workspaceId: string) => string
  statusColor: (workspaceId: string) => string
  isAnimating: (workspaceId: string) => boolean
  ensureWorkspace: (workspaceId: string) => void
  registerTerminal: (terminalId: string, workspaceId: string) => void
  unregisterTerminal: (terminalId: string) => void
  setTerminalPorts: (terminalId: string, ports: number[]) => void
  setTerminalCwd: (terminalId: string, cwd: string) => void
}

export type StatusStore = StatusStoreState & StatusStoreActions

const EMPTY_TERMINAL: TerminalRuntimeStatus = {
  activity: { type: 'idle' },
  agentState: 'notRunning',
  agentName: null,
  agentPresent: false,
  listeningPorts: [],
  cwd: '',
}

function emptyWorkspaceStatus(): WorkspaceStatusState {
  return { terminals: {} }
}

function aggregateAgentState(terminals: Record<string, TerminalRuntimeStatus>): AgentState {
  const states = Object.values(terminals).map((terminal) => terminal.agentState)
  if (states.includes('waitingForInput')) return 'waitingForInput'
  if (states.includes('running')) return 'running'
  if (states.includes('finished')) return 'finished'
  return 'notRunning'
}

function aggregateTerminalActivity(terminals: Record<string, TerminalRuntimeStatus>): TerminalActivity {
  return Object.values(terminals).find((terminal) => terminal.activity.type === 'running')?.activity ?? { type: 'idle' }
}

function patchTerminal(
  workspaces: Record<string, WorkspaceStatusState>,
  workspaceId: string,
  terminalId: string,
  patch: Partial<TerminalRuntimeStatus>,
): Record<string, WorkspaceStatusState> {
  const workspace = workspaces[workspaceId] ?? emptyWorkspaceStatus()
  const terminal = workspace.terminals[terminalId] ?? EMPTY_TERMINAL
  return {
    ...workspaces,
    [workspaceId]: {
      terminals: {
        ...workspace.terminals,
        [terminalId]: { ...terminal, ...patch },
      },
    },
  }
}

export const useStatusStore = create<StatusStore>((set, get) => ({
  workspaces: {},

  ensureWorkspace(workspaceId) {
    if (get().workspaces[workspaceId]) return
    set((state) => ({ workspaces: { ...state.workspaces, [workspaceId]: emptyWorkspaceStatus() } }))
  },

  setTerminalActivity(workspaceId, terminalId, activity) {
    set((state) => {
      const previous = state.workspaces[workspaceId]?.terminals[terminalId]?.activity
      if (previous?.type === activity.type &&
          (activity.type !== 'running' || (previous.type === 'running' && previous.processName === activity.processName))) return state
      return { workspaces: patchTerminal(state.workspaces, workspaceId, terminalId, { activity }) }
    })
  },

  setAgentState(workspaceId, terminalId, agentState, agentName) {
    set((state) => ({
      workspaces: patchTerminal(state.workspaces, workspaceId, terminalId, { agentState, agentName }),
    }))
  },

  setAgentName(workspaceId, terminalId, agentName) {
    set((state) => {
      if (state.workspaces[workspaceId]?.terminals[terminalId]?.agentName === agentName) return state
      return { workspaces: patchTerminal(state.workspaces, workspaceId, terminalId, { agentName }) }
    })
  },

  setAgentPresent(workspaceId, terminalId, agentPresent) {
    set((state) => {
      if (state.workspaces[workspaceId]?.terminals[terminalId]?.agentPresent === agentPresent) return state
      return { workspaces: patchTerminal(state.workspaces, workspaceId, terminalId, { agentPresent }) }
    })
  },

  statusText(workspaceId) {
    const terminals = get().workspaces[workspaceId]?.terminals
    if (!terminals) return 'Idle'
    switch (aggregateAgentState(terminals)) {
      case 'running': return 'Running'
      case 'waitingForInput': return 'Needs Input'
      case 'finished': return 'Finished'
      case 'notRunning': break
    }
    const activity = aggregateTerminalActivity(terminals)
    return activity.type === 'running' ? activity.processName ?? 'Running' : 'Idle'
  },

  statusIcon(workspaceId) {
    const terminals = get().workspaces[workspaceId]?.terminals
    if (!terminals) return ''
    switch (aggregateAgentState(terminals)) {
      case 'running': return '\u26A1'
      case 'waitingForInput': return '\uD83D\uDCAC'
      case 'finished': return '\u2713'
      case 'notRunning': return aggregateTerminalActivity(terminals).type === 'running' ? '\u26A1' : ''
    }
  },

  statusColor(workspaceId) {
    const terminals = get().workspaces[workspaceId]?.terminals
    if (!terminals) return '#8E8E93'
    switch (aggregateAgentState(terminals)) {
      case 'running': return '#007AFF'
      case 'waitingForInput': return '#FF9500'
      case 'finished': return '#34C759'
      case 'notRunning': return aggregateTerminalActivity(terminals).type === 'running' ? '#34C759' : '#8E8E93'
    }
  },

  isAnimating(workspaceId) {
    const terminals = get().workspaces[workspaceId]?.terminals
    return terminals ? aggregateAgentState(terminals) === 'waitingForInput' : false
  },

  registerTerminal(_terminalId, workspaceId) {
    get().ensureWorkspace(workspaceId)
  },

  unregisterTerminal(terminalId) {
    void import('../hooks/useProcessMonitor').then(({ forgetTerminalForProcessMonitor }) => {
      forgetTerminalForProcessMonitor(terminalId)
    })
    void import('../lib/agent/agentScreenDetector').then(({ forgetAgentTracker }) => {
      forgetAgentTracker(terminalId)
    })
    const workspaceId = workspaceResolver(terminalId)
    if (!workspaceId) return
    set((state) => {
      const workspace = state.workspaces[workspaceId]
      if (!workspace?.terminals[terminalId]) return state
      const { [terminalId]: _removed, ...terminals } = workspace.terminals
      return { workspaces: { ...state.workspaces, [workspaceId]: { terminals } } }
    })
  },

  setTerminalPorts(terminalId, listeningPorts) {
    const workspaceId = workspaceResolver(terminalId)
    if (!workspaceId) return
    set((state) => ({ workspaces: patchTerminal(state.workspaces, workspaceId, terminalId, { listeningPorts }) }))
  },

  setTerminalCwd(terminalId, cwd) {
    const workspaceId = workspaceResolver(terminalId)
    if (!workspaceId) return
    set((state) => ({ workspaces: patchTerminal(state.workspaces, workspaceId, terminalId, { cwd }) }))
  },
}))
