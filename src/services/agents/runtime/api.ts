// `cate.agent.*` service handlers (architecture 14). The router validates
// arguments; handlers resolve each panel to its runner.

import { RpcError } from '@kernel/rpc/contract'
import type { CateServiceHandlers } from '@kernel/api/contract'
import type { agentApi } from '../contract/api'
import type { PanelAgentState } from '../contract'
import type { AgentsRuntime } from './agentsRuntime'
import type { AgentStarter } from './start'

function summary(agents: AgentsRuntime, state: PanelAgentState) {
  return {
    panelId: state.panelId,
    runner: state.runner,
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
    .filter((state) => state.runner === 't3' || state.status !== 'notRunning')
}

function live(agents: AgentsRuntime, panelId: string): PanelAgentState {
  const state = agents.registry.sessionFor(panelId)
  if (!state || (state.runner !== 't3' && state.status === 'notRunning')) throw new RpcError('gone', 'agent-panel-not-found')
  return state
}

export function createAgentApiHandlers(agents: AgentsRuntime, starter: AgentStarter): CateServiceHandlers<typeof agentApi> {
  return {
    async start({ canvasPanelId, position, ...args }, ctx) {
      const placement = canvasPanelId ? { near: canvasPanelId, ...(position ? { position } : {}) } : undefined
      return starter.start(ctx.caller.panelId, { ...args, ...(placement ? { placement } : {}) })
    },

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

    async send({ targetPanelId, prompt }) {
      live(agents, targetPanelId)
      const result = await agents.send(targetPanelId, prompt)
      if (!result.ok) throw new RpcError('rejected', result.error)
      return { ok: true }
    },

    async interrupt({ targetPanelId }) {
      live(agents, targetPanelId)
      const result = await agents.interrupt(targetPanelId)
      if (!result.ok) throw new RpcError('rejected', result.error)
      return { ok: true }
    },
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
