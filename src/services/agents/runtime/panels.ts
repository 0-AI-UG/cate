// The agent state of every terminal panel, as the `agents.panels` stream and
// `cate.agent.*` read it: each panel's state from the terminal agents, with
// when relation context last went with its prompt, and a change stream that
// publishes only real changes.

import type { AgentPanelStates, AgentPanelStatesChange, PanelAgentState } from '../contract'

/** Where panel states come from (the terminal agents). */
export interface AgentPanelSource {
  /** The agent the panel hosts, or null. */
  state(panelId: string): PanelAgentState | null
  /** Panels that may host an agent right now. */
  panelIds(): Iterable<string>
  /** A panel's state may have changed. */
  onChange(listener: (panelId: string) => void): () => void
}

export interface AgentPanels {
  /** The panel's agent state, or null when it hosts none. */
  state(panelId: string): PanelAgentState | null
  all(): AgentPanelStates
  subscribe(listener: (change: AgentPanelStatesChange) => void): () => void
  /** Re-reads a panel's state, e.g. after its context was sent. */
  refresh(panelId: string): void
  dispose(): void
}

export interface AgentPanelsOptions {
  /** When relation context last went with the panel's prompt. */
  contextSentAt?(panelId: string): number | undefined
}

const same = (a: PanelAgentState | null | undefined, b: PanelAgentState | null | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function createAgentPanels(source: AgentPanelSource, options: AgentPanelsOptions = {}): AgentPanels {
  const listeners = new Set<(change: AgentPanelStatesChange) => void>()
  const last = new Map<string, PanelAgentState>()

  const state = (panelId: string): PanelAgentState | null => {
    const current = source.state(panelId)
    if (!current) return null
    const sentAt = options.contextSentAt?.(panelId)
    return sentAt === undefined ? current : { ...current, contextSentAt: sentAt }
  }

  const refresh = (panelId: string): void => {
    const next = state(panelId)
    if (same(last.get(panelId), next)) return
    if (next) last.set(panelId, next)
    else last.delete(panelId)
    const change: AgentPanelStatesChange = { [panelId]: next }
    for (const listener of listeners) {
      try { listener(change) } catch { /* a subscriber must not break the others */ }
    }
  }

  const off = source.onChange(refresh)
  for (const panelId of source.panelIds()) refresh(panelId)

  return {
    state,
    all() {
      const out: AgentPanelStates = {}
      for (const panelId of source.panelIds()) {
        const current = state(panelId)
        if (current) out[panelId] = current
      }
      return out
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh,
    dispose: off,
  }
}
