// Starting an agent as a T3 Code thread in a new chat panel: a ready
// instance of the agent's provider (any, without an agent) and its default
// model, unless the caller names them.

import { RpcError } from '@kernel/rpc/contract'
import { AGENTS, AGENT_DEFS, type AgentId } from '../../../contract'
import type { AgentsCore } from '../../core'
import type { AgentStartPorts, RunnerStart } from '../../start'

const fail = (code: string): never => { throw new RpcError('rejected', code) }

type Choice = { instanceId: string; model: string; agentId: AgentId | null }

export function createT3Start(agents: AgentsCore, ports: Pick<AgentStartPorts, 't3' | 'createChat'>): RunnerStart<Choice> {
  return {
    check(args) {
      if (args.terminalPanelId) fail('terminal-requires-terminal-runner')
    },
    async choose(args) {
      const agentId = args.agentId
      const providerId = agentId ? AGENT_DEFS[agentId].runners.t3?.providerId : undefined
      if (agentId && !providerId) fail('agent-not-in-t3')
      const instances = await ports.t3.providerModels()
      const instance = instances.find((candidate) => candidate.ready
        && (args.instanceId ? candidate.instanceId === args.instanceId : !providerId || candidate.providerId === providerId))
      if (!instance) return fail('t3-provider-not-ready')
      const slug = args.model ?? (instance.models.find((candidate) => candidate.isDefault) ?? instance.models[0])?.slug
      if (!slug) return fail('t3-model-not-found')
      const agent = AGENTS.find((candidate) => candidate.runners.t3?.providerId === instance.providerId)
      return { instanceId: instance.instanceId, model: slug, agentId: agent?.id ?? null }
    },
    async launch(choice, { args, prompt, checkout, placement }) {
      const inWorktree = checkout.cwd !== agents.root
      const { threadId } = await ports.t3.startThread({
        ...(inWorktree ? { checkout: checkout.cwd } : {}),
        instanceId: choice.instanceId,
        model: choice.model,
        text: prompt,
      })
      try {
        const panelId = ports.createChat({
          threadId,
          ...(inWorktree ? checkout : {}),
          ...(args.title?.trim() ? { title: args.title.trim() } : {}),
          placement,
        })
        if (!panelId) fail('panel-creation-failed')
        return { panelId: panelId!, agentId: choice.agentId }
      } catch (error) {
        // No chat shows the thread: end it before its worktree goes.
        await ports.t3.stopThread({ ...(inWorktree ? { checkout: checkout.cwd } : {}), threadId }).catch(() => {})
        throw error
      }
    },
  }
}
