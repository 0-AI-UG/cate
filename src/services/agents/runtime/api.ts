// `cate.agent.*` service handlers (architecture 14). The router validates
// arguments; handlers resolve each panel to its runner.

import { RpcError } from '@kernel/rpc/contract'
import type { CateServiceHandlers } from '@kernel/api/contract'
import type { agentApi } from '../contract/api'
import type { AgentStartRequest, PanelAgentState } from '../contract'
import type { AgentsRuntime } from './agentsRuntime'
import type { AgentStarter } from './start'

const runnerOf = (agents: AgentsRuntime, panelId: string) => agents.registry.runnerFor(panelId)?.kind ?? 'terminal'

function summary(agents: AgentsRuntime, state: PanelAgentState) {
  return {
    panelId: state.panelId,
    runner: runnerOf(agents, state.panelId),
    title: agents.document.panel(state.panelId)?.title ?? '',
    agentId: state.agentId,
    agentName: state.agentName,
    state: state.status,
    canReceivePrompt: state.canReceivePrompt,
  }
}

/** Agent panels list, send and wait agree on: a terminal whose CLI agent is
 *  observable, or a chat whose harness is live (including a fresh chat its
 *  first prompt will start). */
function liveAgents(agents: AgentsRuntime): PanelAgentState[] {
  return Object.values(agents.registry.all())
    .filter((state) => runnerOf(agents, state.panelId) === 't3' || state.status !== 'notRunning')
}

function live(agents: AgentsRuntime, panelId: string): PanelAgentState {
  const state = agents.registry.sessionFor(panelId)
  if (!state || (runnerOf(agents, panelId) !== 't3' && state.status === 'notRunning')) throw new RpcError('gone', 'agent-panel-not-found')
  return state
}

/** Starts an agent for a caller panel (a client: none), placing it on a
 *  canvas when asked: `cate agent start` and the agents capability. */
export function startAgent(starter: AgentStarter, callerPanelId: string | undefined, request: AgentStartRequest) {
  const { canvasPanelId, position, ...args } = request
  const placement = canvasPanelId ? { near: canvasPanelId, ...(position ? { position } : {}) } : undefined
  return starter.start(callerPanelId, { ...args, ...(placement ? { placement } : {}) })
}

/** A prompt to a live agent panel: `cate agent send` and the capability. */
export async function sendToAgent(agents: AgentsRuntime, panelId: string, prompt: string): Promise<{ ok: true }> {
  live(agents, panelId)
  const result = await agents.send(panelId, prompt)
  if (!result.ok) throw new RpcError('rejected', result.error)
  return { ok: true }
}

/** Stops a live agent panel's turn: `cate agent interrupt` and the capability. */
export async function interruptAgent(agents: AgentsRuntime, panelId: string): Promise<{ ok: true }> {
  live(agents, panelId)
  const result = await agents.interrupt(panelId)
  if (!result.ok) throw new RpcError('rejected', result.error)
  return { ok: true }
}

export function createAgentApiHandlers(agents: AgentsRuntime, starter: AgentStarter): CateServiceHandlers<typeof agentApi> {
  return {
    start: (args, ctx) => startAgent(starter, ctx.caller.panelId, args as AgentStartRequest),

    types: () => starter.types(),

    list: () => liveAgents(agents).map((state) => summary(agents, state)),

    async read({ panelId }) {
      const state = live(agents, panelId)
      if (!state.session) throw new RpcError('rejected', 'no-agent-session')
      const runner = agents.registry.runnerFor(panelId)
      let conversation: Awaited<ReturnType<NonNullable<typeof runner>['conversation']>>
      try {
        conversation = await runner!.conversation(panelId)
      } catch {
        throw new RpcError('rejected', 'agent-conversation-unavailable')
      }
      if (!conversation) throw new RpcError('gone', 'agent-conversation-not-found')
      return { ...summary(agents, state), session: conversation.session, messages: conversation.messages }
    },

    wait: ({ panelIds, timeoutSeconds }, ctx) => waitForAgents(agents, panelIds ?? [], timeoutSeconds, ctx.signal),

    send: ({ targetPanelId, prompt }) => sendToAgent(agents, targetPanelId, prompt),

    interrupt: ({ targetPanelId }) => interruptAgent(agents, targetPanelId),
  }
}

function waitForAgents(agents: AgentsRuntime, panelIds: string[], timeoutSeconds: number, signal: AbortSignal) {
  type Result = { agents: ReturnType<typeof summary>[]; timedOut: boolean }
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
    const selected = (): PanelAgentState[] | null => {
      const available = liveAgents(agents)
      if (panelIds.length === 0) return available
      const picked = panelIds.map((id) => available.find((state) => state.panelId === id))
      return picked.every(Boolean) ? picked as PanelAgentState[] : null
    }
    const check = (): void => {
      const states = selected()
      if (!states) { finish(new RpcError('gone', 'agent-panel-not-found')); return }
      if (states.every((state) => state.canReceivePrompt)) {
        finish({ agents: states.map((state) => summary(agents, state)), timedOut: false })
      }
    }
    const onAbort = (): void => finish(new RpcError('timeout', 'wait cancelled'))
    const off = agents.registry.subscribe(check)
    const timer = setTimeout(() => {
      const available = liveAgents(agents)
      const states = panelIds.length > 0 ? available.filter((state) => panelIds.includes(state.panelId)) : available
      finish({ agents: states.map((state) => summary(agents, state)), timedOut: true })
    }, timeoutSeconds * 1_000)
    signal.addEventListener('abort', onAbort)
    check()
  })
}
