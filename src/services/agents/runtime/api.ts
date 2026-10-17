// `cate.agent.*` service handlers (architecture 14). The router validates
// arguments; handlers resolve each panel to its agent.

import { RpcError } from '@kernel/rpc/contract'
import type { CateServiceHandlers } from '@kernel/api/contract'
import type { agentApi } from '../contract/api'
import { AGENT_DEFS, type AgentId, type AgentStartRequest, type PanelAgentState } from '../contract'
import type { AgentsCore } from './core'
import type { AgentStarter } from './start'

function summary(agents: AgentsCore, state: PanelAgentState) {
  return {
    panelId: state.panelId,
    title: agents.document.panel(state.panelId)?.title ?? '',
    agentId: state.agentId,
    agentName: state.agentName,
    state: state.status,
    canReceivePrompt: state.canReceivePrompt,
  }
}

/** A started agent before its CLI is observed: listed and waited for, not
 *  yet prompted. */
function startingSummary(agents: AgentsCore, { panelId, agentId }: { panelId: string; agentId: AgentId }) {
  return {
    panelId,
    title: agents.document.panel(panelId)?.title ?? '',
    agentId,
    agentName: AGENT_DEFS[agentId].displayName,
    state: 'starting',
    canReceivePrompt: false,
  }
}

type AgentSummary = ReturnType<typeof summary> | ReturnType<typeof startingSummary>

/** Every agent panel `list` and `wait` see, starting ones last. */
function agentSummaries(agents: AgentsCore, starter: AgentStarter): AgentSummary[] {
  return [
    ...liveAgents(agents).map((state) => summary(agents, state)),
    ...starter.starting().map((started) => startingSummary(agents, started)),
  ]
}

/** Prompting or reading an agent that is still starting fails with a hint. */
function refuseStarting(starter: AgentStarter, panelId: string): void {
  if (starter.starting().some((started) => started.panelId === panelId)) {
    throw new RpcError('rejected', 'agent-starting: wait until it is ready with cate agent wait')
  }
}

/** Agent panels list, send and wait agree on: a terminal whose CLI agent is
 *  observable. */
function liveAgents(agents: AgentsCore): PanelAgentState[] {
  return Object.values(agents.panels.all()).filter((state) => state.status !== 'notRunning')
}

function live(agents: AgentsCore, panelId: string): PanelAgentState {
  const state = agents.panels.state(panelId)
  if (state && state.status !== 'notRunning') return state
  // A terminal with no agent in it (a relation can hand off to a shell).
  if ([...agents.terminals.panelIds()].includes(panelId)) {
    throw new RpcError('gone', 'no-agent-in-terminal: no agent runs there; use cate terminal read, type and press on it')
  }
  throw new RpcError('gone', 'agent-panel-not-found')
}

/** Starts an agent for a caller panel (a client: none), placing it on a
 *  canvas when asked: `cate agent start` and the agents capability. */
export function startAgent(starter: AgentStarter, callerPanelId: string | undefined, request: AgentStartRequest) {
  const { canvasPanelId, position, at, ...args } = request
  const placement = at ? { at } : canvasPanelId ? { near: canvasPanelId, ...(position ? { position } : {}) } : undefined
  return starter.start(callerPanelId, { ...args, ...(placement ? { placement } : {}) })
}

/** A prompt to a live agent panel: `cate agent send` and the capability. */
export async function sendToAgent(agents: AgentsCore, panelId: string, prompt: string): Promise<{ ok: true }> {
  live(agents, panelId)
  const result = await agents.send(panelId, prompt)
  if (!result.ok) throw new RpcError('rejected', result.error)
  return { ok: true }
}

/** Stops a live agent panel's turn: `cate agent interrupt` and the capability. */
export async function interruptAgent(agents: AgentsCore, panelId: string): Promise<{ ok: true }> {
  live(agents, panelId)
  const result = await agents.interrupt(panelId)
  if (!result.ok) throw new RpcError('rejected', result.error)
  return { ok: true }
}

export function createAgentApiHandlers(agents: AgentsCore, starter: AgentStarter): CateServiceHandlers<typeof agentApi> {
  return {
    start: (args, ctx) => startAgent(starter, ctx.caller.panelId, args as AgentStartRequest),

    types: () => starter.types(),

    list: () => agentSummaries(agents, starter),

    async read({ panelId }) {
      refuseStarting(starter, panelId)
      const state = live(agents, panelId)
      if (!state.session) throw new RpcError('rejected', 'no-agent-session')
      let conversation: Awaited<ReturnType<typeof agents.terminals.conversation>>
      try {
        conversation = await agents.terminals.conversation(panelId)
      } catch {
        throw new RpcError('rejected', 'agent-conversation-unavailable')
      }
      if (!conversation) throw new RpcError('gone', 'agent-conversation-not-found')
      return { ...summary(agents, state), session: conversation.session, messages: conversation.messages }
    },

    wait: ({ panelIds, timeoutSeconds }, ctx) => waitForAgents(agents, starter, panelIds ?? [], timeoutSeconds, ctx.signal),

    send: async ({ targetPanelId, prompt }) => {
      refuseStarting(starter, targetPanelId)
      return sendToAgent(agents, targetPanelId, prompt)
    },

    interrupt: async ({ targetPanelId }) => {
      refuseStarting(starter, targetPanelId)
      return interruptAgent(agents, targetPanelId)
    },
  }
}

function waitForAgents(agents: AgentsCore, starter: AgentStarter, panelIds: string[], timeoutSeconds: number, signal: AbortSignal) {
  type Result = { agents: AgentSummary[]; timedOut: boolean }
  return new Promise<Result>((resolve, reject) => {
    let settled = false
    const finish = (outcome: Result | RpcError): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      off()
      signal.removeEventListener('abort', onAbort)
      if (outcome instanceof RpcError) reject(outcome)
      else resolve(outcome)
    }
    // A starting agent is waited for: it becomes ready once its CLI is up.
    const selected = (): AgentSummary[] | null => {
      const available = agentSummaries(agents, starter)
      if (panelIds.length === 0) return available
      const picked = panelIds.map((id) => available.find((entry) => entry.panelId === id))
      return picked.every(Boolean) ? picked as AgentSummary[] : null
    }
    const check = (): void => {
      const entries = selected()
      if (!entries) { finish(new RpcError('gone', 'agent-panel-not-found')); return }
      if (entries.every((entry) => entry.canReceivePrompt)) finish({ agents: entries, timedOut: false })
    }
    const onAbort = (): void => finish(new RpcError('timeout', 'wait cancelled'))
    const off = agents.panels.subscribe(check)
    const timer = setTimeout(() => {
      const available = agentSummaries(agents, starter)
      const entries = panelIds.length > 0 ? available.filter((entry) => panelIds.includes(entry.panelId)) : available
      finish({ agents: entries, timedOut: true })
    }, timeoutSeconds * 1_000)
    signal.addEventListener('abort', onAbort)
    check()
  })
}
