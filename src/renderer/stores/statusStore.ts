// =============================================================================
// Status Store — Zustand state for workspace status, terminal activity,
// and node activity states.
// Ported from WorkspaceStatus.swift
// =============================================================================

import { create } from 'zustand'
import type {
  CanvasNodeId,
  NodeActivityState,
  AgentState,
  TerminalActivity,
  GitInfo,
} from '../../shared/types'

// -----------------------------------------------------------------------------
// Per-workspace status
// -----------------------------------------------------------------------------

interface WorkspaceStatusState {
  terminalActivity: Record<string, TerminalActivity>
  agentState: Record<string, AgentState>
  agentName: Record<string, string | null>
  nodeActivity: Record<CanvasNodeId, NodeActivityState>
  terminalTitles: Record<string, string>
  listeningPorts: Record<string, number[]>      // terminalId → ports
  terminalCwd: Record<string, string>            // terminalId → cwd
}

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

interface StatusStoreState {
  /** Per-workspace status, keyed by workspace ID. */
  workspaces: Record<string, WorkspaceStatusState>
  /** Timers for auto-clearing commandFinished states. */
  _clearTimers: Record<string, ReturnType<typeof setTimeout>>
  terminalWorkspaceMap: Record<string, string>
  gitInfo: Record<string, GitInfo>
}

interface StatusStoreActions {
  // Mutations
  setTerminalActivity: (workspaceId: string, terminalId: string, activity: TerminalActivity) => void
  setAgentState: (workspaceId: string, terminalId: string, state: AgentState, name: string | null) => void
  setNodeActivity: (nodeId: CanvasNodeId, state: NodeActivityState) => void
  clearNodeActivity: (nodeId: CanvasNodeId) => void
  setTerminalTitle: (terminalId: string, title: string) => void

  // Derived getters (per workspace)
  statusText: (workspaceId: string) => string
  statusIcon: (workspaceId: string) => string
  statusColor: (workspaceId: string) => string
  isAnimating: (workspaceId: string) => boolean

  // Ensure workspace entry exists
  ensureWorkspace: (workspaceId: string) => void

  registerTerminal: (terminalId: string, workspaceId: string) => void
  unregisterTerminal: (terminalId: string) => void
  setTerminalPorts: (terminalId: string, ports: number[]) => void
  setTerminalCwd: (terminalId: string, cwd: string) => void
  setGitInfo: (workspaceId: string, branch: string, isDirty: boolean) => void
}

export type StatusStore = StatusStoreState & StatusStoreActions

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const AUTO_CLEAR_DELAY_MS = 5000

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function emptyWorkspaceStatus(): WorkspaceStatusState {
  return {
    terminalActivity: {},
    agentState: {},
    agentName: {},
    nodeActivity: {},
    terminalTitles: {},
    listeningPorts: {},
    terminalCwd: {},
  }
}

/** Find the "most important" agent state across all terminals in a workspace. */
function aggregateAgentState(states: Record<string, AgentState>): AgentState {
  const vals = Object.values(states)
  // Priority: waitingForInput > running > finished > notRunning
  if (vals.includes('waitingForInput')) return 'waitingForInput'
  if (vals.includes('running')) return 'running'
  if (vals.includes('finished')) return 'finished'
  return 'notRunning'
}

/** Find the "most important" terminal activity across all terminals. */
function aggregateTerminalActivity(activities: Record<string, TerminalActivity>): TerminalActivity {
  const vals = Object.values(activities)
  // Any running terminal wins
  const running = vals.find((a) => a.type === 'running')
  if (running) return running
  return { type: 'idle' }
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useStatusStore = create<StatusStore>((set, get) => ({
  // --- State ---
  workspaces: {},
  _clearTimers: {},
  terminalWorkspaceMap: {},
  gitInfo: {},

  // --- Actions ---

  ensureWorkspace(workspaceId) {
    const state = get()
    if (!state.workspaces[workspaceId]) {
      set({
        workspaces: {
          ...state.workspaces,
          [workspaceId]: emptyWorkspaceStatus(),
        },
      })
    }
  },

  setTerminalActivity(workspaceId, terminalId, activity) {
    get().ensureWorkspace(workspaceId)
    set((state) => {
      const ws = state.workspaces[workspaceId] ?? emptyWorkspaceStatus()
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            terminalActivity: { ...ws.terminalActivity, [terminalId]: activity },
          },
        },
      }
    })
  },

  setAgentState(workspaceId, terminalId, agentState, agentName) {
    get().ensureWorkspace(workspaceId)
    set((state) => {
      const ws = state.workspaces[workspaceId] ?? emptyWorkspaceStatus()
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            agentState: { ...ws.agentState, [terminalId]: agentState },
            agentName: { ...ws.agentName, [terminalId]: agentName },
          },
        },
      }
    })
  },

  setNodeActivity(nodeId, activityState) {
    // Cancel any pending clear for this node
    const state = get()
    const timerKey = nodeId
    const existingTimer = state._clearTimers[timerKey]
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    // Find which workspace this node belongs to — for now, update a global
    // nodeActivity map across all workspaces that contain this node.
    // Simplified: store nodeActivity in every workspace (status is global-ish).
    const updatedWorkspaces = { ...state.workspaces }
    for (const wsId of Object.keys(updatedWorkspaces)) {
      const ws = updatedWorkspaces[wsId]
      updatedWorkspaces[wsId] = {
        ...ws,
        nodeActivity: { ...ws.nodeActivity, [nodeId]: activityState },
      }
    }

    const updatedTimers = { ...state._clearTimers }
    delete updatedTimers[timerKey]

    // Auto-clear commandFinished after 5 seconds
    if (activityState.type === 'commandFinished') {
      updatedTimers[timerKey] = setTimeout(() => {
        get().clearNodeActivity(nodeId)
      }, AUTO_CLEAR_DELAY_MS)
    }

    set({ workspaces: updatedWorkspaces, _clearTimers: updatedTimers })
  },

  clearNodeActivity(nodeId) {
    const state = get()
    const timerKey = nodeId
    const existingTimer = state._clearTimers[timerKey]
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const updatedWorkspaces = { ...state.workspaces }
    for (const wsId of Object.keys(updatedWorkspaces)) {
      const ws = updatedWorkspaces[wsId]
      const { [nodeId]: _removed, ...remainingActivity } = ws.nodeActivity
      updatedWorkspaces[wsId] = {
        ...ws,
        nodeActivity: remainingActivity,
      }
    }

    const { [timerKey]: _removedTimer, ...remainingTimers } = state._clearTimers
    set({ workspaces: updatedWorkspaces, _clearTimers: remainingTimers })
  },

  setTerminalTitle(terminalId, title) {
    // Update terminal title in all workspaces that track this terminal
    set((state) => {
      const updatedWorkspaces = { ...state.workspaces }
      for (const wsId of Object.keys(updatedWorkspaces)) {
        const ws = updatedWorkspaces[wsId]
        if (ws.terminalActivity[terminalId] != null) {
          updatedWorkspaces[wsId] = {
            ...ws,
            terminalTitles: { ...ws.terminalTitles, [terminalId]: title },
          }
        }
      }
      return { workspaces: updatedWorkspaces }
    })
  },

  // --- Derived getters ---

  statusText(workspaceId) {
    const ws = get().workspaces[workspaceId]
    if (!ws) return 'Idle'

    const claude = aggregateAgentState(ws.agentState)
    if (claude !== 'notRunning') {
      switch (claude) {
        case 'running':
          return 'Running'
        case 'waitingForInput':
          return 'Needs Input'
        case 'finished':
          return 'Finished'
        default:
          return ''
      }
    }

    const activity = aggregateTerminalActivity(ws.terminalActivity)
    switch (activity.type) {
      case 'idle':
        return 'Idle'
      case 'running':
        return activity.processName ?? 'Running'
    }
  },

  statusIcon(workspaceId) {
    const ws = get().workspaces[workspaceId]
    if (!ws) return ''

    const claude = aggregateAgentState(ws.agentState)
    switch (claude) {
      case 'running':
        return '\u26A1' // ⚡
      case 'waitingForInput':
        return '\uD83D\uDCAC' // 💬
      case 'finished':
        return '\u2713' // ✓
      case 'notRunning':
        break
    }

    const activity = aggregateTerminalActivity(ws.terminalActivity)
    switch (activity.type) {
      case 'idle':
        return ''
      case 'running':
        return '\u26A1' // ⚡
    }
  },

  statusColor(workspaceId) {
    const ws = get().workspaces[workspaceId]
    if (!ws) return '#8E8E93' // systemGray

    const claude = aggregateAgentState(ws.agentState)
    switch (claude) {
      case 'running':
        return '#007AFF' // systemBlue
      case 'waitingForInput':
        return '#FF9500' // systemOrange
      case 'finished':
        return '#34C759' // systemGreen
      case 'notRunning':
        break
    }

    const activity = aggregateTerminalActivity(ws.terminalActivity)
    switch (activity.type) {
      case 'idle':
        return '#8E8E93' // systemGray
      case 'running':
        return '#34C759' // systemGreen
    }

    return '#8E8E93'
  },

  isAnimating(workspaceId) {
    const ws = get().workspaces[workspaceId]
    if (!ws) return false
    return aggregateAgentState(ws.agentState) === 'waitingForInput'
  },

  registerTerminal(terminalId, workspaceId) {
    set((state) => ({
      terminalWorkspaceMap: { ...state.terminalWorkspaceMap, [terminalId]: workspaceId },
    }))
  },

  unregisterTerminal(terminalId) {
    set((state) => {
      const { [terminalId]: _removed, ...remainingMap } = state.terminalWorkspaceMap

      const workspaceId = state.terminalWorkspaceMap[terminalId]
      const updatedWorkspaces = { ...state.workspaces }
      if (workspaceId && updatedWorkspaces[workspaceId]) {
        const ws = updatedWorkspaces[workspaceId]
        const { [terminalId]: _p, ...remainingPorts } = ws.listeningPorts
        const { [terminalId]: _c, ...remainingCwd } = ws.terminalCwd
        const { [terminalId]: _a, ...remainingActivity } = ws.terminalActivity
        const { [terminalId]: _s, ...remainingAgent } = ws.agentState
        const { [terminalId]: _an, ...remainingAgentName } = ws.agentName
        const { [terminalId]: _t, ...remainingTitles } = ws.terminalTitles
        updatedWorkspaces[workspaceId] = {
          ...ws,
          listeningPorts: remainingPorts,
          terminalCwd: remainingCwd,
          terminalActivity: remainingActivity,
          agentState: remainingAgent,
          agentName: remainingAgentName,
          terminalTitles: remainingTitles,
        }
      }

      return {
        terminalWorkspaceMap: remainingMap,
        workspaces: updatedWorkspaces,
      }
    })
  },

  setTerminalPorts(terminalId, ports) {
    set((state) => {
      const workspaceId = state.terminalWorkspaceMap[terminalId]
      if (!workspaceId) return state
      const ws = state.workspaces[workspaceId] ?? emptyWorkspaceStatus()
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            listeningPorts: { ...ws.listeningPorts, [terminalId]: ports },
          },
        },
      }
    })
  },

  setTerminalCwd(terminalId, cwd) {
    set((state) => {
      const workspaceId = state.terminalWorkspaceMap[terminalId]
      if (!workspaceId) return state
      const ws = state.workspaces[workspaceId] ?? emptyWorkspaceStatus()
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            terminalCwd: { ...ws.terminalCwd, [terminalId]: cwd },
          },
        },
      }
    })
  },

  setGitInfo(workspaceId, branch, isDirty) {
    set((state) => ({
      gitInfo: { ...state.gitInfo, [workspaceId]: { branch, isDirty } },
    }))
  },
}))

