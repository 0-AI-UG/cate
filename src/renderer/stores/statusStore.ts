import { create } from 'zustand'
import type { AgentId } from '../../shared/agents'
import type { AgentState, TerminalActivity } from '../../shared/types'

export interface TerminalRuntimeStatus {
  activity: TerminalActivity
  agentState: AgentState
  /** The hook-registered agent CLI. Kept after the agent exits so the
   *  finished state can still name it; gate on `agentPresent` for liveness. */
  agentId: AgentId | null
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
  setAgentState: (workspaceId: string, terminalId: string, state: AgentState) => void
  setAgentId: (workspaceId: string, terminalId: string, agentId: AgentId | null) => void
  setAgentPresent: (workspaceId: string, terminalId: string, present: boolean) => void
  ensureWorkspace: (workspaceId: string) => void
  registerTerminal: (terminalId: string, workspaceId: string) => void
  unregisterTerminal: (terminalId: string, workspaceId?: string) => void
  setTerminalPorts: (terminalId: string, ports: number[]) => void
  setTerminalCwd: (terminalId: string, cwd: string) => void
}

export type StatusStore = StatusStoreState & StatusStoreActions

const EMPTY_TERMINAL: TerminalRuntimeStatus = {
  activity: { type: 'idle' },
  agentState: 'notRunning',
  agentId: null,
  agentPresent: false,
  listeningPorts: [],
  cwd: '',
}

function emptyWorkspaceStatus(): WorkspaceStatusState {
  return { terminals: {} }
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

  setAgentState(workspaceId, terminalId, agentState) {
    set((state) => ({
      workspaces: patchTerminal(state.workspaces, workspaceId, terminalId, { agentState }),
    }))
  },

  setAgentId(workspaceId, terminalId, agentId) {
    set((state) => {
      if (state.workspaces[workspaceId]?.terminals[terminalId]?.agentId === agentId) return state
      return { workspaces: patchTerminal(state.workspaces, workspaceId, terminalId, { agentId }) }
    })
  },

  setAgentPresent(workspaceId, terminalId, agentPresent) {
    set((state) => {
      if (state.workspaces[workspaceId]?.terminals[terminalId]?.agentPresent === agentPresent) return state
      return { workspaces: patchTerminal(state.workspaces, workspaceId, terminalId, { agentPresent }) }
    })
  },

  registerTerminal(_terminalId, workspaceId) {
    get().ensureWorkspace(workspaceId)
  },

  unregisterTerminal(terminalId, knownWorkspaceId) {
    void import('../lib/agent/agentScreenDetector').then(({ forgetAgentTracker }) => {
      forgetAgentTracker(terminalId)
    })
    // Disposal removes the terminal identity bimap before calling us so
    // re-entrant lifecycle calls are inert. Accept the workspace captured by
    // that lifecycle; other callers can still resolve a live terminal here.
    const workspaceId = knownWorkspaceId ?? workspaceResolver(terminalId)
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
