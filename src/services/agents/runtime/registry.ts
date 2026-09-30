// The runner registry: `sessionFor(panel)` answers which agent a panel hosts
// and through which runner. Replaces the `agentHost` definition hook and the
// renderer's agent surfaces. Callers never ask which runner a panel uses.

import type {
  AgentConversationMessage,
  AgentPanelStates,
  AgentPanelStatesChange,
  AgentRunner,
  AgentSendResult,
  AgentSession,
  PanelAgentState,
} from '../contract'

/** One way agent sessions execute. Implemented by runners/terminal and runners/t3. */
export interface AgentRunnerImpl {
  readonly kind: AgentRunner
  /** The agent the panel hosts through this runner, or null. */
  state(panelId: string): PanelAgentState | null
  /** Panels this runner may host an agent in right now. */
  panelIds(): Iterable<string>
  /** Submit a prompt as the user would. */
  send(panelId: string, prompt: string): Promise<AgentSendResult>
  conversation(panelId: string): Promise<{ session: AgentSession; messages: AgentConversationMessage[] } | null>
  /** A panel's state may have changed. */
  onChange(listener: (panelId: string) => void): () => void
}

export interface RunnerRegistry {
  register(runner: AgentRunnerImpl): () => void
  /** The panel's agent state, or null when it hosts none. */
  sessionFor(panelId: string): PanelAgentState | null
  runnerFor(panelId: string): AgentRunnerImpl | null
  all(): AgentPanelStates
  subscribe(listener: (change: AgentPanelStatesChange) => void): () => void
}

const same = (a: PanelAgentState | null | undefined, b: PanelAgentState | null | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function createRunnerRegistry(): RunnerRegistry {
  const runners = new Map<AgentRunnerImpl, () => void>()
  const listeners = new Set<(change: AgentPanelStatesChange) => void>()
  const last = new Map<string, PanelAgentState>()

  const runnerFor = (panelId: string): AgentRunnerImpl | null => {
    for (const runner of runners.keys()) if (runner.state(panelId)) return runner
    return null
  }
  const sessionFor = (panelId: string): PanelAgentState | null => {
    for (const runner of runners.keys()) {
      const state = runner.state(panelId)
      if (state) return state
    }
    return null
  }

  const refresh = (panelId: string): void => {
    const next = sessionFor(panelId)
    if (same(last.get(panelId), next)) return
    if (next) last.set(panelId, next)
    else last.delete(panelId)
    const change: AgentPanelStatesChange = { [panelId]: next }
    for (const listener of listeners) {
      try { listener(change) } catch { /* a subscriber must not break the others */ }
    }
  }

  return {
    register(runner) {
      const off = runner.onChange(refresh)
      runners.set(runner, off)
      for (const panelId of runner.panelIds()) refresh(panelId)
      return () => {
        off()
        runners.delete(runner)
        for (const panelId of [...last.keys()]) refresh(panelId)
      }
    },
    sessionFor,
    runnerFor,
    all() {
      const out: AgentPanelStates = {}
      for (const runner of runners.keys()) {
        for (const panelId of runner.panelIds()) {
          const state = out[panelId] ? null : runner.state(panelId)
          if (state) out[panelId] = state
        }
      }
      return out
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
