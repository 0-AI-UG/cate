// The `cate` API as a client calls it (the `api` capability): the methods
// the app uses, by their declared names, with their results typed here.

import type { RuntimeProxy } from '@kernel/rpc/contract'
import type { AgentConversationMessage, AgentId, CodingAgentAction, CompactCodingAgentSnapshot } from '@services/agents/contract'

interface AgentCalls {
  read: { args: { panelId: string }; result: { messages: AgentConversationMessage[] } }
  send: { args: { targetPanelId: string; prompt: string }; result: { ok: true } }
}

/** `cate.agent.<name>`: a live agent panel's conversation and prompts. */
export function agent<N extends keyof AgentCalls>(runtime: RuntimeProxy, name: N, args: AgentCalls[N]['args']): Promise<AgentCalls[N]['result']> {
  return runtime.api.call({ method: `cate.agent.${name}`, args }) as Promise<AgentCalls[N]['result']>
}

interface CodingAgentCalls {
  create: { args: { prompt: string; agentId?: AgentId; newWorktree?: string }; result: CompactCodingAgentSnapshot }
  list: { args: Record<string, never>; result: CompactCodingAgentSnapshot[] }
  agents: { args: Record<string, never>; result: Array<{ agentId: AgentId; displayName: string }> }
}

type CodingAgentCall = CodingAgentCalls & { [A in CodingAgentAction]: { args: { runId: string }; result: CompactCodingAgentSnapshot } }

/** `cate.codingAgent.<name>`: as a client, the person's own workers and a say
 *  about every worker. */
export function codingAgent<N extends keyof CodingAgentCall>(
  runtime: RuntimeProxy,
  name: N,
  args: CodingAgentCall[N]['args'],
): Promise<CodingAgentCall[N]['result']> {
  return runtime.api.call({ method: `cate.codingAgent.${name}`, args }) as Promise<CodingAgentCall[N]['result']>
}
