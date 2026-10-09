import { channelStream, defineCapability, method, stream } from '@kernel/rpc/contract'
import type { AgentConversation, AgentConversationChange } from './conversation'
import type { AgentHookAgentState } from './hooks'
import type { AgentNotificationEvent, AgentRunner, PanelAgentState } from './session'
import type { AgentId } from './registry'
import type { AgentTypeInfo } from './launch'

/** Starting an agent from a client, as `cate agent start` does from a
 *  terminal: a new terminal or T3 chat panel, placed on a canvas when asked. */
export interface AgentStartRequest {
  prompt: string
  runner?: AgentRunner
  agentId?: AgentId
  instanceId?: string
  model?: string
  title?: string
  worktreeId?: string
  newWorktree?: string
  canvasPanelId?: string
  position?: { x: number; y: number }
}

/** Every panel hosting an agent, keyed by panel id. */
export type AgentPanelStates = Record<string, PanelAgentState>
/** A change to `AgentPanelStates`: null removes the panel. */
export type AgentPanelStatesChange = Record<string, PanelAgentState | null>

export function applyAgentPanelStatesChange(states: AgentPanelStates, change: AgentPanelStatesChange): AgentPanelStates {
  const next = { ...states }
  for (const [panelId, state] of Object.entries(change)) {
    if (state) next[panelId] = state
    else delete next[panelId]
  }
  return next
}

/** The agents service (architecture 10.4). Paths are absolute paths inside
 *  the workspace root or one of its worktree checkouts. */
export const agentsCapability = defineCapability('agents', {
  methods: {
    /** Per-agent hook injection state of a checkout (defaults to the root). */
    inspectHooks: method<{ cwd?: string }, AgentHookAgentState[]>(),
    /** The agent a panel hosts, or null. */
    panel: method<{ panelId: string }, PanelAgentState | null>(),
    /** Agents running a turn right now (closing their panels interrupts them). */
    busy: method<void, { panelIds: string[] }>(),
    /** The same functions as `cate agent start / types / send / interrupt`. */
    start: method<AgentStartRequest, { panelId: string; runner: AgentRunner; agentId: AgentId | null }>({ mutates: true, timeoutMs: 90_000 }),
    types: method<void, AgentTypeInfo[]>(),
    send: method<{ panelId: string; prompt: string }, { ok: true }>({ mutates: true }),
    interrupt: method<{ panelId: string }, { ok: true }>({ mutates: true }),
  },
  streams: {
    /** Every agent panel's state: a snapshot, then changes. */
    panels: channelStream<void, AgentPanelStates, AgentPanelStatesChange>(),
    /** A panel's agent conversation with its state, live while the agent
     *  works: a snapshot, then changes. */
    conversation: channelStream<{ panelId: string }, AgentConversation, AgentConversationChange>(),
    /** Agent notification events (architecture 10.5). */
    notifications: stream<void, AgentNotificationEvent>(),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    agents: typeof agentsCapability
  }
}
