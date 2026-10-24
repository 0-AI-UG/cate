import { channelStream, defineCapability, method } from '@kernel/rpc/contract'
import type { AgentConversation, AgentConversationChange } from './conversation'
import type { AgentHookAgentState } from './hooks'
import type { PanelAgentState } from './session'
import type { AgentId } from './registry'
import type { AgentTypeInfo } from './launch'
import type { PlaceTarget } from '@workspace/document/contract'
import type { UsageLimitsReport, UsagePricing, UsageSummary, UsageSummaryInput } from './usage/types'

/** Starting an agent from a client, as `cate agent start` does from a
 *  terminal: a new terminal panel, placed on a canvas when asked. Without a
 *  prompt the agent opens its interactive session. */
export interface AgentStartRequest {
  prompt?: string
  /** Files that go with the prompt: absolute paths on the runtime's machine
   *  (a prompt of only attachments may be empty). */
  attachments?: string[]
  agentId?: AgentId
  title?: string
  worktreeId?: string
  newWorktree?: string
  canvasPanelId?: string
  position?: { x: number; y: number }
  /** A spot the client already picked (the placement picker). */
  at?: PlaceTarget
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

/** The agents service (architecture 10.3). Paths are absolute paths inside
 *  the workspace root or one of its worktree checkouts. */
export const agentsCapability = defineCapability('agents', {
  methods: {
    /** Per-agent hook injection state of a checkout (defaults to the root). */
    inspectHooks: method<{ cwd?: string }, AgentHookAgentState[]>(),
    /** The agent a panel hosts, or null. */
    panel: method<{ panelId: string }, PanelAgentState | null>(),
    /** The relation context the panel's next prompt would take, exactly as
     *  sent (null: none). */
    previewContext: method<{ panelId: string }, string | null>(),
    /** Agents running a turn right now (closing their panels interrupts them). */
    busy: method<void, { panelIds: string[] }>(),
    /** The same functions as `cate agent start / types / send / interrupt`. */
    start: method<AgentStartRequest, { panelId: string; agentId: AgentId | null }>({ mutates: true, timeoutMs: 90_000 }),
    types: method<void, AgentTypeInfo[]>(),
    /** The same function as `cate agent send`: the runtime takes the prompt
     *  and sends it once the agent can take one, after those before it; its
     *  outcome shows in the conversation's prompts. `attachments`: files that
     *  go with it, absolute paths on the runtime's machine (a prompt of only
     *  attachments may be empty). */
    send: method<{ panelId: string; prompt: string; attachments?: string[] }, { promptId: string }>({ mutates: true }),
    /** Takes back a queued or failed prompt (its text and attachments, for
     *  the composer); null when there is none. */
    withdraw: method<{ panelId: string; promptId: string }, { prompt: string; attachments: string[] }>({ mutates: true }),
    interrupt: method<{ panelId: string }, { ok: true }>({ mutates: true }),
    /** The agent CLIs' usage in this workspace for a window, totalled per
     *  agent, model and period (a cold 90-day scan reads every transcript
     *  on the machine). */
    usage: method<UsageSummaryInput, UsageSummary>({ timeoutMs: 180_000 }),
    /** Refetches the model rate table ahead of its daily refresh. */
    refreshUsageRates: method<void, UsagePricing>({ timeoutMs: 20_000 }),
    /** The signed-in accounts' subscription windows, asked of the CLIs,
     *  with what is left and the pace; `refresh` skips the minute-long cache. */
    usageLimits: method<{ refresh?: boolean }, UsageLimitsReport>({ timeoutMs: 45_000 }),
  },
  streams: {
    /** Every agent panel's state: a snapshot, then changes. */
    panels: channelStream<void, AgentPanelStates, AgentPanelStatesChange>(),
    /** A panel's agent conversation with its state, live while the agent
     *  works: a snapshot, then changes. */
    conversation: channelStream<{ panelId: string }, AgentConversation, AgentConversationChange>(),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    agents: typeof agentsCapability
  }
}
