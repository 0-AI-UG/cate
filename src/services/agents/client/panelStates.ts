// The agent state of every panel of a workspace, mirrored from the `agents`
// capability's `panels` stream. One subscription per workspace, shared by
// every consumer and closed when the last one releases it.

import { mirrorChannel, subscribeRuntimes, tryRuntimeFor, type ChannelMirror } from '@kernel/rpc/client'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import { applyAgentPanelStatesChange, type AgentId, type AgentPanelStates, type PanelAgentState } from '../contract'

const EMPTY: AgentPanelStates = Object.freeze({}) as AgentPanelStates

interface Entry {
  refs: number
  states: AgentPanelStates
  runtime: RuntimeProxy | null
  mirror: ChannelMirror<AgentPanelStates> | null
  listeners: Set<() => void>
  stopRuntimes: () => void
}

const entries = new Map<string, Entry>()

export interface AgentPanelsHandle {
  getSnapshot(): AgentPanelStates
  subscribe(listener: () => void): () => void
  /** Drops this consumer; the last release closes the stream. */
  release(): void
}

function notify(entry: Entry): void {
  for (const listener of [...entry.listeners]) {
    try { listener() } catch { /* isolate listeners */ }
  }
}

function connect(workspaceId: string, entry: Entry): void {
  const runtime = tryRuntimeFor(workspaceId)
  if (runtime === entry.runtime && (entry.mirror || !runtime)) return
  entry.mirror?.dispose()
  entry.mirror = null
  entry.runtime = runtime
  const hadStates = entry.states !== EMPTY
  entry.states = EMPTY
  if (runtime) {
    const mirror = mirrorChannel(
      () => runtime.agents.panels(undefined, { resume: true }),
      applyAgentPanelStatesChange,
    )
    mirror.subscribe((state) => {
      entry.states = state?.snapshot ?? EMPTY
      notify(entry)
    })
    entry.mirror = mirror
  }
  if (hadStates) notify(entry)
}

/** Takes a reference on the workspace's agent panel states. */
export function acquireAgentPanels(workspaceId: string): AgentPanelsHandle {
  let entry = entries.get(workspaceId)
  if (!entry) {
    const created: Entry = {
      refs: 0,
      states: EMPTY,
      runtime: null,
      mirror: null,
      listeners: new Set(),
      stopRuntimes: () => {},
    }
    entries.set(workspaceId, created)
    created.stopRuntimes = subscribeRuntimes(() => connect(workspaceId, created))
    connect(workspaceId, created)
    entry = created
  }
  entry.refs++
  const own = entry
  let released = false
  return {
    getSnapshot: () => own.states,
    subscribe(listener) {
      own.listeners.add(listener)
      return () => { own.listeners.delete(listener) }
    },
    release() {
      if (released) return
      released = true
      if (--own.refs > 0) return
      own.stopRuntimes()
      own.mirror?.dispose()
      own.listeners.clear()
      if (entries.get(workspaceId) === own) entries.delete(workspaceId)
    },
  }
}

/** The current states without taking a reference (empty when nobody holds one). */
export function peekAgentPanels(workspaceId: string): AgentPanelStates {
  return entries.get(workspaceId)?.states ?? EMPTY
}

/** The agent open in a panel right now: present, with a known agent. */
export function openAgentOf(state: PanelAgentState | undefined): AgentId | null {
  return state?.present ? state.agentId : null
}

/** Terminal panels with a recognized agent CLI open (from launch). */
export function cliAgentOpenByPanel(states: AgentPanelStates): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [panelId, state] of Object.entries(states)) {
    if (state.runner === 'terminal') out[panelId] = state.present
  }
  return out
}

/** The agent CLI open in each terminal panel; null once it exited. */
export function cliAgentByPanel(states: AgentPanelStates): Record<string, AgentId | null> {
  const out: Record<string, AgentId | null> = {}
  for (const [panelId, state] of Object.entries(states)) {
    if (state.runner === 'terminal') out[panelId] = openAgentOf(state)
  }
  return out
}
