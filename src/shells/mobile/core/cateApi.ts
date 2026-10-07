// The `cate` API as a client calls it (the `api` capability): the methods
// the app uses, by their declared names, with their results typed here.

import type { RuntimeProxy } from '@kernel/rpc/contract'
import type { AgentId, AgentRunner, AgentTypeInfo } from '@services/agents/contract'

interface AgentCalls {
  start: {
    args: {
      prompt: string
      runner: AgentRunner
      agentId?: AgentId
      instanceId?: string
      model?: string
      newWorktree?: string
      canvasPanelId?: string
      position?: { x: number; y: number }
    }
    result: { panelId: string; runner: AgentRunner; agentId: AgentId | null }
  }
  types: { args: Record<string, never>; result: AgentTypeInfo[] }
  send: { args: { targetPanelId: string; prompt: string }; result: { ok: true } }
  interrupt: { args: { targetPanelId: string }; result: { ok: true } }
}

/** `cate.agent.<name>`: starting agents, and a live agent panel's prompts
 *  and turns. */
export function agent<N extends keyof AgentCalls>(runtime: RuntimeProxy, name: N, args: AgentCalls[N]['args']): Promise<AgentCalls[N]['result']> {
  return runtime.api.call({ method: `cate.agent.${name}`, args }) as Promise<AgentCalls[N]['result']>
}
